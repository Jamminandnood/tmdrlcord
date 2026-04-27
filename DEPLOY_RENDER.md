# Render.com 배포 가이드

이 채팅 서버는 Render.com의 **Web Service** 타입으로 배포할 수 있어요.
Vercel은 영구 WebSocket 연결을 지원하지 않아 사용할 수 없습니다.

## 1. 사전 준비

- 이 코드를 GitHub 저장소에 올립니다.
- Render.com 계정을 만듭니다 (무료 플랜으로 시작 가능).

## 2. 배포 방법 (블루프린트 사용 — 가장 쉬움)

이 저장소에는 `render.yaml` 파일이 포함되어 있어서 한 번에 설정됩니다.

1. Render 대시보드 → **New +** → **Blueprint** 선택
2. GitHub 저장소를 연결하고 이 레포를 선택
3. `render.yaml` 자동 감지 → **Apply**
4. `ADMIN_PASSWORD` 환경변수에 원하는 관리자 비밀번호 입력
   (기본 사용자명은 `admin`)

배포가 완료되면 `https://realtime-chat-xxxx.onrender.com` 같은 URL이 발급됩니다.

## 3. 수동 설정 (블루프린트 없이)

Render 대시보드에서 직접 만들 경우:

| 항목                | 값                                                                               |
| ------------------- | -------------------------------------------------------------------------------- |
| Service type        | **Web Service**                                                                  |
| Runtime             | Node                                                                             |
| Root Directory      | `artifacts/api-server`                                                           |
| Build Command       | `corepack enable && pnpm install --frozen-lockfile=false && pnpm run build`      |
| Start Command       | `pnpm run start`                                                                 |
| Health Check Path   | `/`                                                                              |
| Persistent Disk     | mount `/opt/render/project/src/artifacts/api-server/.data` (1 GB 이상)           |

### 환경변수

| 키                | 설명                                            |
| ----------------- | ----------------------------------------------- |
| `NODE_ENV`        | `production`                                    |
| `SESSION_SECRET`  | 임의의 긴 문자열 (Render의 generateValue 사용 추천) |
| `ADMIN_USERNAME`  | 시드 관리자 사용자명 (기본 `admin`)             |
| `ADMIN_PASSWORD`  | 시드 관리자 비밀번호 (반드시 변경)              |

## 4. 영구 디스크가 중요합니다

- 계정 정보(`accounts.json`)와 채널 정보(`channels.json`)는 디스크에 저장됩니다.
- Render의 무료 플랜은 디스크가 없으며 재배포 시 데이터가 사라집니다.
- 실제로 운영하려면 **Starter 플랜 ($7/월) + 디스크 1GB** 조합을 권장합니다.

## 5. 이미지 업로드는 비활성화됩니다

- 이미지/아바타 업로드 기능은 Replit의 객체 저장소를 사용해서 만들어졌어요.
- Render에서는 이 기능이 자동으로 비활성화되며, 채팅과 다른 기능은 모두 정상 작동합니다.
- Render에서 이미지 업로드까지 사용하려면 별도의 S3 호환 저장소(AWS S3, Cloudflare R2 등)와 연결 코드가 필요해요.

## 6. 주의사항

- Render 무료 플랜은 15분간 트래픽이 없으면 슬립 상태가 되어 다음 요청 시 콜드 스타트가 발생합니다.
- WebSocket 연결은 슬립으로 끊어질 수 있어서 클라이언트가 자동 재연결합니다.
- 항상 깨어있어야 한다면 Starter 플랜을 사용하세요.
