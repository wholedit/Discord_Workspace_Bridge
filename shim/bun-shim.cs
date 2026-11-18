// bun.exe wrapper for workspace-bridge (Windows only).
//
// Why: claude (2.1.32x on Windows) runs with a Bun inspector on a local port and passes BUN_INSPECT=ws://127.0.0.1:<port>/
// to the MCP servers it starts. The official Discord plugin runs on Bun, so its Bun tries to open an inspector on the
// same port, fails with EADDRINUSE and exits — the plugin never connects.
//
// What: this wrapper is placed first on PATH for workspace sessions only. It removes BUN_INSPECT* from its own
// environment and runs the real bun.exe with the exact same command line and standard handles, then exits with its code.
// The real Bun runs inside a job object, so it is terminated if this wrapper is killed.
//
// Build: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize /out:bun.exe bun-shim.cs

using System;
using System.Collections;
using System.IO;
using System.Runtime.InteropServices;

static class BunShim
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong R, W, O, RB, WB, OB; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic;
        public IO_COUNTERS Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
    [DllImport("kernel32")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32")] static extern uint ResumeThread(IntPtr t);

    const uint CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400;
    const int STARTF_USESTDHANDLES = 0x100;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    /// The command line after the program name, exactly as received.
    static string ArgsTail(string cmdline)
    {
        int i = 0;
        if (cmdline.StartsWith("\"")) { i = cmdline.IndexOf('"', 1); i = i < 0 ? cmdline.Length : i + 1; }
        else { while (i < cmdline.Length && cmdline[i] != ' ' && cmdline[i] != '\t') i++; }
        return cmdline.Substring(i).TrimStart(' ', '\t');
    }

    static int Main()
    {
        string real = Environment.GetEnvironmentVariable("WSB_REAL_BUN");
        if (string.IsNullOrEmpty(real))
            real = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".bun\\bin\\bun.exe");
        if (!File.Exists(real))
        {
            Console.Error.WriteLine("workspace-bridge bun wrapper: real bun.exe not found at " + real + " (set WSB_REAL_BUN)");
            return 127;
        }

        // Drop inspector settings; the child inherits the rest of this environment.
        foreach (DictionaryEntry e in Environment.GetEnvironmentVariables())
        {
            string k = (string)e.Key;
            if (k.StartsWith("BUN_INSPECT", StringComparison.OrdinalIgnoreCase)) Environment.SetEnvironmentVariable(k, null);
        }

        string tail = ArgsTail(Environment.CommandLine);
        string cmd = "\"" + real + "\"" + (tail.Length > 0 ? " " + tail : "");

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(-10);
        si.hStdOutput = GetStdHandle(-11);
        si.hStdError = GetStdHandle(-12);

        PROCESS_INFORMATION pi;
        if (!CreateProcess(real, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref si, out pi))
        {
            Console.Error.WriteLine("workspace-bridge bun wrapper: failed to start bun (error " + Marshal.GetLastWin32Error() + ")");
            return 126;
        }

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        AssignProcessToJobObject(job, pi.hProcess); // best effort: if it fails, bun still runs

        ResumeThread(pi.hThread);
        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        return (int)code;
    }
}
