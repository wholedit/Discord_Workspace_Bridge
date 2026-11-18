# 7. 문제 해결

먼저 이 세 가지를 보세요.

```bash
npm run check
```

```bash
npm run status
```

```bash
npm run logs
```

폰에서는 `/dashboard`, `/logs ws:이름`.

## 봇이 오프라인

| 상태 (`npm run status`, `/dashboard`) | 원인과 해결 |
|---|---|
| 실행 관리자 `NOT running` | 꺼져 있습니다. `npm run start:bg` 또는 설정 페이지에서 시작 |
| 🔐 `needs-trust` | 처음 쓰는 폴더. `npm run trust -- 이름` 또는 설정 페이지의 **폴더 신뢰 확인** → `Yes, I trust this folder` → `/exit` |
| 🔴 `bot token is no longer valid` | 토큰을 재발급한 봇. 설정 페이지에서 같은 봇을 새 토큰으로 다시 추가 |
| 🟡 `connecting…`이 2분 넘게 | 공식 플러그인은 시작할 때마다 `bun install`을 해서 처음엔 오래 걸릴 수 있습니다. 계속이면 아래 "플러그인 연결 실패" |
| 🔴 `plugin failed` | 아래 "플러그인 연결 실패" |
| 🟠 `restarting`이 반복 | `/logs ws:이름` 또는 `npm run launch -- 이름`(실행 관리자를 먼저 끄고)으로 화면을 직접 보세요 |

## 플러그인 연결 실패

- **Bun 설치 확인**: `npm run check`. 설치 직후라면 터미널을 새로 열고 실행 관리자를 다시 시작하세요.
- **한 번 실패하면 약 15분간 재시도 안 함**: `claude`가 실패를 기억합니다. `/restart ws:이름` 후 기다리거나, 실행 관리자를 끄고 `npm run launch -- 이름`으로 열어 `/mcp` → discord → 다시 연결하면 원인이 보입니다.
- **`CONNECTION_CLOSED`**: Windows에서 `claude`가 플러그인에 디버거 설정을 넘겨 생기는 문제입니다. 이 프로그램은 `bun.exe` 래퍼로 우회합니다. 래퍼를 만들 수 없으면(`.NET csc.exe` 없음, 보안 프로그램 차단) 이 문제가 생깁니다.

## 봇은 온라인인데 반응이 없음

- **MESSAGE CONTENT INTENT**가 켜져 있는지 (설정 페이지 3단계).
- 메시지를 보낸 계정이 **등록한 계정**인지. 다른 계정의 메시지는 무시됩니다.
- **올바른 채널**인지. 봇은 자기 채널만 봅니다.
- 계정을 바꾸려면 설정 페이지에서 같은 봇을 다시 추가하면서 계정을 고르세요.

## 승인 DM이 안 옴

- `auto` 모드에서는 위험이 낮은 작업은 묻지 않고 진행합니다. 매번 확인하려면 `/mode ws:이름 mode:manual`.
- 봇과 **같은 서버**에 있어야 DM을 받을 수 있습니다. 디스코드 개인정보 설정에서 서버 멤버의 DM을 막아 두지 않았는지 확인하세요.

## 진행 메시지가 안 생김

- 도구를 쓰지 않는 간단한 답에는 진행 메시지가 없습니다 (정상).
- `npm run launch`(창 모드)로 실행하면 진행 메시지는 꺼져 있습니다.

## 네트워크·인증서

- **`fetch failed`, `SELF_SIGNED_CERT_IN_CHAIN`**: 회사망이나 보안 프로그램이 HTTPS를 검사하는 환경입니다. 반드시 `npm run …` 스크립트로 실행하세요 (Windows 인증서 저장소를 쓰도록 되어 있음). `npm run check`의 "Discord reachable"로 확인.
- **`npm install`이 몇 분째 멈춤**: 취소하고 다시 실행해 보세요.

## 실행 관리자

- **"The supervisor is already running"**: 이미 켜져 있습니다. `npm run stop`. 그 프로세스가 없는데도 나오면 안내된 `supervisor.pid` 파일을 지우세요.
- **`npm run stop`이 30초 안에 안 끝남**: `npm run logs`를 확인하세요. 그래도 안 되면 PC를 다시 시작하는 것이 가장 확실합니다 (작업 관리자로 강제 종료하면 워크스페이스의 `claude.exe`가 남을 수 있습니다).

## 설정 페이지

- **"Open the link printed by npm run setup"**: 주소의 `?k=…`가 빠졌습니다. 터미널에 나온 링크 전체를 쓰세요.
- **"사이트에 연결할 수 없음"**: 설정 페이지가 꺼졌습니다 ("설정 끝내기" 또는 20분 미사용). 다시 `npm run setup`. 포트 번호는 실행할 때마다 바뀝니다.
- **PC 점검이 오래 걸림**: `claude` 명령이 느린 PC에서는 1분 가까이 걸릴 수 있습니다. 그동안 다른 기능은 쓸 수 있습니다.
- **슬래시 명령(`/dashboard`)이 안 보임**: 디스코드 앱을 완전히 껐다 켜세요. 관리용 봇 초대에 `applications.commands`가 빠졌다면 설정 페이지에서 관리용 봇을 다시 추가하면서 초대 링크로 다시 초대하세요.

## 보안 프로그램이 막음 (회사 PC)

- **`bun.exe` 차단**: 플러그인이 연결되지 않습니다. 보안 담당자에게 `~/.workspace-bridge/shim/bun.exe` 예외를 요청하세요.
- **`awake.exe` 차단**: 절전 방지만 안 됩니다. `WSB_ALLOW_SLEEP=1`로 끄고, Windows 전원 설정에서 절전을 "안 함"으로 두세요.

## 기타

- **평소 PC에서 `claude`를 열면 `plugin:discord` 연결 실패가 보임**: 정상입니다. 워크스페이스로 실행할 때만 토큰이 주어져서 연결됩니다. `/discord:configure`는 쓰지 마세요.
- **같은 워크스페이스를 `npm run launch`와 실행 관리자로 동시에 켬**: 같은 봇이 두 번 접속합니다. 하나만 쓰세요.
- **새 대화로 시작하고 싶음**: `/new ws:이름` 또는 `npm start -- --fresh=이름`.
- 해결되지 않으면 GitHub 이슈에 `npm run check`, `npm run status` 결과와 `npm run logs`의 관련 부분을 첨부해 주세요. **봇 토큰이 들어 있지 않은지 확인**하고 올리세요.
