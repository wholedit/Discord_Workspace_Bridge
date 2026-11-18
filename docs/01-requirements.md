# 1. 준비물

설정 페이지(`npm run setup`)의 **1. 이 PC 점검**이 아래 항목을 자동으로 확인하고, 빠진 것은 고치는 방법을 보여 줍니다. 터미널에서는 `npm run check`로 같은 점검을 할 수 있습니다.

## 필요한 것

| 항목 | 설명 |
|---|---|
| **Windows 10/11 PC** | 켜 둘 작업용 PC. (macOS·Linux는 아직 검증하지 않았습니다. 아래 참고) |
| **Claude 구독** | Pro 또는 Max. 각자 자기 구독을 씁니다 |
| **Claude Code** | 공식 `claude` 명령. 설치 후 **한 번 실행해서 로그인** |
| **Node.js 22.15 이상** | 이 프로그램을 실행 |
| **Bun** | 공식 디스코드 플러그인이 Bun으로 실행됨 |
| **공식 디스코드 플러그인** | `discord@claude-plugins-official` |
| **Git** | 이 저장소를 받을 때 (ZIP으로 받아도 됨) |
| **디스코드 계정과 개인 서버** | 봇을 초대할 서버. 개인 서버를 새로 만드는 것을 권장 |
| **.NET Framework 4.x** | Windows에 기본 포함. 작은 도우미 프로그램 두 개를 PC에서 직접 빌드하는 데 씀 |

## 설치 순서

### 1) Node.js
https://nodejs.org 에서 LTS 버전을 설치합니다.

### 2) Claude Code
설치 방법: https://code.claude.com/docs/en/quickstart

설치한 뒤 터미널에서 한 번 실행해 **내 Claude 계정으로 로그인**합니다.

```bash
claude
```

> 팀·엔터프라이즈 조직 계정은 관리자가 채널 기능을 허용해야 할 수 있습니다 ("blocked by org policy"). 개인 Pro/Max 구독은 해당 없습니다.

### 3) Bun
PowerShell에서 실행한 뒤 **터미널을 새로 엽니다**.

```bash
powershell -c "irm bun.sh/install.ps1 | iex"
```

### 4) 공식 디스코드 플러그인
`claude`를 실행하고 프롬프트에 입력합니다. 설치 범위는 **user scope**를 고릅니다.

```
/plugin install discord@claude-plugins-official
```

`Marketplace "claude-plugins-official" not found`가 나오면 먼저 아래를 입력합니다.

```
/plugin marketplace add anthropics/claude-plugins-official
```

> `/discord:configure`는 **쓰지 마세요.** 기본 폴더에 토큰을 저장해서 이후 여는 모든 `claude`가 그 봇으로 접속하려고 합니다. 토큰은 이 프로그램이 워크스페이스별 폴더에 따로 저장합니다.

### 5) 디스코드
1. 디스코드 앱에서 **개인 서버**를 만듭니다 (+ 버튼 → 직접 만들기).
2. 워크스페이스로 쓸 텍스트 채널을 만듭니다 (예: `#web`, `#api`). 관리용 봇을 쓸 거면 `#control`도 만듭니다.
3. 계정에 **2단계 인증**을 켭니다. 이 디스코드 계정이 곧 PC를 원격 조작하는 권한이 됩니다.

## 요금
이 프로그램은 무료입니다. Claude 사용량은 **각자의 Claude 구독**에서 차감됩니다. 워크스페이스 여러 개를 동시에 돌리면 구독 사용 한도에 더 빨리 도달할 수 있습니다.

## macOS·Linux
`npm start`(터미널 실행), `npm run start:bg`, 설정 페이지의 대부분은 동작하도록 만들었지만 아직 검증하지 않았습니다. 자동 시작과 절전 방지는 Windows만 지원합니다. tmux 같은 곳에서 `npm start`를 켜 두는 방식을 권장합니다.
