# claude-tldraw

[English](README.EN.md) · 한국어

Claude Code 안에서 tldraw 캔버스를 쓰는 플러그인입니다. Claude가 tldraw에 다이어그램을 그리면, 브라우저 창 없이 Claude Code의 pane에 바로 보입니다.

- **pane 안에서 보기**: 터미널에서는 블록 문자로 그린 그림 위에 글자를 실제 터미널 문자로 겹쳐 그려서 한글도 선명합니다. Claude Desktop의 Code 탭에서는 SVG로 보입니다.
- **조작**: 드래그로 이동, 휠로 커서 위치 확대/축소. 그림을 클릭한 뒤 `←↑↓→` `+` `-` `f`(맞추기) `d`(다크 모드).
- **저장**: 캔버스는 이 PC에 저장되어 다음 세션에도 남습니다.
- **tldraw.com 공식 MCP 포함**: tldraw.com 계정에 로그인하면 Claude가 내 보드 목록 조회, 새 보드 만들기, 보드 스크린샷 보기를 할 수 있습니다.

## 설치

> **tldraw를 쓰려면 Claude 플러그인 `claude.ai tldraw`를 연결해야 합니다.** claude.ai에서 tldraw 커넥터를 추가한 뒤, Claude Code의 `/mcp` 목록에 `claude.ai tldraw`가 연결됨으로 보이는지 확인하세요.

Claude Code에서:

```
/plugin marketplace add j-token/claude-tldraw
/plugin install tldraw@claude-tldraw
```

설치 후 "tldraw로 우리 서비스 아키텍처 그려줘"처럼 요청하거나 `/tldraw`로 pane을 여세요.

tldraw.com 기능을 쓰려면 `/mcp`에서 `tldraw-com`을 골라 한 번 로그인하세요 (선택).

## 필요 조건

- Claude Code v2.1.287 이상 (mod 지원), 터미널 또는 Claude Desktop의 Code 탭
- Claude 플러그인 `claude.ai tldraw` 연결
- Node.js 18 이상 (`node`가 PATH에 있어야 함)
- Chromium 계열 브라우저: Microsoft Edge 또는 Google Chrome. 화면에 창을 띄우지 않는 headless 모드로만 씁니다. 다른 위치에 설치했다면 `TLDRAW_BROWSER` 환경 변수에 실행 파일 경로를 지정하세요.
- 처음 실행할 때 tldraw 글꼴을 인터넷에서 받습니다.

## 동작 방식

```
Claude ──mcp__tldraw__exec──▶ mod (hooks/register.tsx)
                                 │ HTTP (127.0.0.1:7717, 토큰 인증)
                                 ▼
                         server/server.mjs ──▶ headless Edge/Chrome
                                 ▲                 └ tldraw 5 (server/dist/app.js)
                                 └── 화면 셀/라벨 ◀──┘
mod ──Raster + 글자 겹치기──▶ Claude Code pane
```

- pane을 닫으면 서버와 headless 브라우저도 종료됩니다. 30분 동안 쓰지 않아도 스스로 종료됩니다.
- 서버는 `127.0.0.1`에서만 열리고, 실행할 때마다 새로 만드는 토큰이 없으면 요청을 거절합니다.
- 데이터 위치: `CLAUDE_PLUGIN_DATA`, 없으면 `~/.claude/plugins/data/tldraw`

## 개발

```
plugins/tldraw/
├─ .claude-plugin/plugin.json   매니페스트 (tldraw.com MCP 포함)
├─ hooks/                       mod: register.tsx, canvas-input.ts, 테스트
└─ server/
   ├─ server.mjs                의존성 없는 로컬 서버
   ├─ index.html
   ├─ dist/                     미리 빌드한 페이지 번들 (커밋됨)
   └─ web/                      번들 소스 (src/main.js)
```

페이지 번들을 고친 뒤:

```
cd plugins/tldraw/server/web
npm install
npm run build
```

확인:

```
claude plugin validate plugins/tldraw
claude plugin test plugins/tldraw
claude --plugin-dir plugins/tldraw     # 이 세션에서만 불러와 써 보기
```

## 라이선스

이 플러그인은 [tldraw SDK](https://tldraw.dev)를 묶어서 씁니다. tldraw SDK는 [tldraw 라이선스](https://tldraw.dev/community/license)를 따르며, localhost에서 쓰는 것은 개발 용도로 간주되어 라이선스 키가 필요 없습니다.
