# workspace-bridge

휴대폰의 Discord에서 로컬 Claude Code 워크스페이스를 제어하는 브리지입니다. 워크스페이스마다 봇을 하나씩 두고, Anthropic의 공식 Discord 채널 플러그인을 사용합니다. 각자 자기 Claude 구독으로 로그인한 공식 `claude`를 그대로 실행하며, 이 프로그램은 Claude 로그인 정보를 다루지 않습니다.

> 개발 중입니다 (M3: 설정 페이지·백그라운드 실행·자동 시작). 전체 계획은 [PLAN.md](PLAN.md)에 있습니다.

## 빠른 사용법 (Windows)

```bash
npm install
```

```bash
npm run setup
```

설정 페이지가 PC 점검, 봇 연결, 채널·폴더 선택, 실행, 자동 시작까지 안내합니다.

| 명령 | 하는 일 |
|---|---|
| `npm run setup` | **설정 페이지 열기 (권장)** |
| `npm run start:bg` / `npm run stop` | 창 없이 백그라운드 실행 / 종료 |
| `npm run autostart -- on` | Windows 로그인 시 자동 시작 |
| `npm run logs` | 백그라운드 로그 보기 |
| `npm run trust -- 이름` | 폴더 신뢰 확인 창 열기 |
| `npm run check` | 이 PC가 준비됐는지 점검 |
| `npm run add` | 워크스페이스 추가 (봇 토큰 → 채널 → 폴더) |
| `npm start` | 터미널에서 실행 (자동 재시작, 진행 표시, 관리용 봇, 절전 방지) |
| `npm run status` | 실행 상태 보기 |
| `npm run mode -- 이름 모드` | 권한 모드 바꾸기: `auto`(기본), `manual`, `acceptEdits`, `plan` |
| `npm run add-manager` | 관리용 봇 등록 (`#control`에서 `/dashboard`, `/restart`, `/stop`, `/mode`, 알림) |
| `npm run launch -- 이름` | 창 모드로 열기 (디버깅용) |
| `npm run list` / `npm run remove -- 이름` | 목록 보기 / 삭제 |

자세한 내용: [M0 설정 가이드](docs/M0-POC.md), [M1 가이드](docs/M1.md), [M2 관리용 봇](docs/M2.md), [M3 설정 페이지·자동 시작](docs/M3.md)
