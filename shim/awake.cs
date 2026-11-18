// awake.exe <pid>
// Keeps Windows from going to sleep while the given process (the supervisor) is alive.
// The screen may still turn off. Exits by itself when that process exits, so it can never be left behind.
// Built by src/winTools.ts with the .NET Framework compiler that ships with Windows.

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

class Awake
{
    [DllImport("kernel32.dll")]
    static extern uint SetThreadExecutionState(uint flags);

    const uint ES_CONTINUOUS = 0x80000000;
    const uint ES_SYSTEM_REQUIRED = 0x00000001;

    static int Main(string[] args)
    {
        int pid;
        if (args.Length < 1 || !int.TryParse(args[0], out pid)) return 2;
        Process parent;
        try { parent = Process.GetProcessById(pid); }
        catch { return 3; }
        if (SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) == 0) return 4;
        parent.WaitForExit();
        return 0;
    }
}
