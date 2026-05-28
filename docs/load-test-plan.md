# 부하 테스트 계획서

> 작성일: 2026-05-22
> 실행 방식: 계획서 팀 공유 → 솔로 실행 → 결과 문서 공유
> 근거: `deployment-checklist.md` E "부하 테스트 진행 (EC2, RDS 인스턴스 유형 결정 목적)"

---

## 1. 배경 / 목적

- 기존 결론: "t3.small 단일 EC2로 300명 충분" (`aws-architecture.md`)
- 변경점: 리크루팅 **임시저장(draft-save)** 도입 → 지원자가 최종 제출 전 여러 번 쓰기 요청을 보냄 → DB 쓰기·커넥션 점유 프로파일이 바뀜
- 목적: 바뀐 부하 패턴에서 현 사양(EC2 t3.small / RDS db.t3.micro)이 견디는지 **재검증**
- 산출물: EC2/RDS 인스턴스 유형 + HikariCP 커넥션 풀 설정 확정

---

## 2. 판정 기준

| 구분 | 지표 | 합격선 |
| --- | --- | --- |
| 클라이언트(k6) | `http_req_duration` p95 | < 1s |
| 클라이언트(k6) | `http_req_failed` | < 1% |
| 서버 | RDS `DatabaseConnections` | < 50 (한도 ~60) |
| 서버 | EC2 / RDS CPU·메모리 | 지속 80% 미만 |
| 서버 | JVM 힙 / GC | GC stop-the-world 누적 없음, 힙 상승 후 회수 정상 |

> stress 시나리오(300 VU)에서 위를 모두 만족하면 "현 사양 유지". 어디서 깨지면 그 지점이 곧 권고(인스턴스 업 / 풀 튜닝 / RDS 사양 조정)로 이어짐.

---

## 3. 대상 환경

- **prod 직접** — 5/25~5/29 윈도우. 6/1 서비스 오픈 전이라 실유저 없음. 이 윈도우가 지나면 prod 부하 테스트 기회가 사라짐.
- k6 트래픽: `https://api.bigdataboaz.com/api/v1` (CloudFront 경유 = 실제 경로, 번들 WAF 포함 검증)
- 서버 지표 수집: 로컬 Prometheus가 **SSH 터널**로 EC2의 `/actuator/prometheus` 스크랩
  - `ssh -L 9090:localhost:8080 <ec2>` → 로컬 Prometheus 타겟을 `localhost:9090`으로
  - 보안그룹 변경 불필요, 엔드포인트 비공개 유지
- ⚠️ prod RDS에 `LOADTEST_*` 더미가 적재됨 → **테스트 후 정리 필수** (§9)

---

## 4. 시나리오 설계

기존 `backend-load-test/k6-script/script.js`의 3개 시나리오 골격을 재사용하되, 임시저장/제출을 분리한다.

| 시나리오 | 모사 대상 | 동작 | 제출 |
| --- | --- | --- | --- |
| `load` | 평상시 모집 트래픽 | 조회 → 양식 → **임시저장 반복** | X |
| `stress` | 마감 직전 누적 부하 | 조회 → 양식 → **임시저장 반복** (300 VU까지 램프업) | X |
| `spike` | **마감 직전 일괄 제출** | 각 VU가 최종 제출 1회 | O |

**설계 의도 (실제 지원자 행동 모사)**
- 지원자는 모집 기간 내내 임시저장을 여러 번 한다 → `load`/`stress`에서 `PUT .../draft`를 반복 호출
- `draft`는 upsert(멱등)라 같은 유저가 반복 호출해도 `409`가 안 남 → 반복 부하에 적합
- 최종 제출은 마감 직전에 몰린다 → `spike`에서 `POST .../applications`를 한꺼번에
- 제출은 `(recruitment_id, user_id)` UNIQUE라 **VU당 1회만** 수행 (k6 `per-vu-iterations` executor 또는 제출 플래그 사용). 2회 이상이면 `409 ALREADY_SUBMITTED`로 에러율이 오염됨

**깔때기 비율**: 조회 100% → 양식 70% → 임시저장 (반복) — 기존 스크립트의 funnel 유지

---

## 5. 인증 방식 (확정)

제출·임시저장이 user JWT 필수가 되어, k6 가상유저 300명을 인증시켜야 한다. OAuth 핸드셰이크는 부하 테스트 대상이 아니므로 건너뛰고, **앱의 실제 토큰 발급 코드로 토큰을 미리 찍어둔다.**

### 토큰 구조 (확인 완료 — `JwtProvider.generateUserAccessToken`)
- `subject` = userId, `claim type=USER`, `claim tokenType=ACCESS`
- HS256 대칭키, prod `JWT_SECRET`으로 서명 → 어디서 찍든 prod에서 검증됨
- ⚠️ access token 만료가 **15분**(`jwt.access-token-expiration: 900000`) → 그대로 찍으면 테스트 도중 만료됨

### 절차
1. **테스트 유저 ~300명을 prod `users`에 시드** — 식별 가능한 더미 OAuth 정보로 SQL insert
   (예: `provider='TEST'`, `provider_id='loadtest_001'` ~ `loadtest_300'`)
2. **토큰 일괄 발급 (일회성 생성기)** — `loadtest` 프로파일의 `@Test` 또는 `CommandLineRunner`에서 `jwtProvider.generateUserAccessToken(userId)` 호출
   - `application-loadtest.yml`에서 `jwt.access-token-expiration`을 수 시간(예: `10800000` = 3h)으로 override → 테스트 윈도우를 덮는 토큰 생성
   - 결과를 `userId,token` 형태 `tokens.csv`로 덤프
3. **k6가 `SharedArray`로 `tokens.csv` 로드** → VU별 `tokens[__VU]` 매핑 (VU당 고유 유저)
4. 제출/임시저장 요청에 `Authorization: Bearer <token>` 헤더 부착

### 토큰 발급 엔드포인트는 쓰지 않음
prod 대상 테스트라 엔드포인트 방식은 prod에 토큰 발급 API를 노출 = 인증 우회 구멍. 정적 파일 방식이 더 안전하고 간단.

---

## 6. k6 스크립트 갱신 사항

기존 `script.js` 대비 수정 필요:

- [ ] `BASE_URL` → `https://api.bigdataboaz.com/api/v1`
- [ ] 제출 엔드포인트 → `POST /recruitment/{recruitmentId}/applications` (경로에 recruitmentId)
- [ ] 임시저장 호출 추가 → `PUT /recruitment/{recruitmentId}/applications/draft`
- [ ] 요청 body에서 `recruitment_id` 제거 (경로 파라미터로 이동)
- [ ] `track`: `'엔지니어링'` → **`'ENGINEERING'`** (`Track` enum: `ANALYSIS`/`VISUALIZATION`/`ENGINEERING`)
- [ ] `military_status`: `'필_또는_면제'` → **`'COMPLETED_OR_EXEMPT'`** (enum: `COMPLETED_OR_EXEMPT`/`NOT_COMPLETED`)
- [ ] `questions` 쿼리: `track=ENGINEERING` (한글 URL 인코딩 아님)
- [ ] 제출/임시저장에 `Authorization: Bearer` 헤더 추가, 토큰 `SharedArray` 로드
- [ ] `answers`의 `question_id`를 **시드한 테스트 공고의 실제 question_id와 일치**시킬 것
- [ ] 시나리오별로 제출/임시저장 분리 (§4)
- [ ] `load`/`stress` 시나리오 draft 루프에 `sleep(15)` 추가 — 프론트 15초 auto-sync 반영 (수동 저장 버튼은 별도 모델링 불필요)

---

## 7. 사전 준비 체크리스트

- [ ] `micrometer-registry-prometheus` 의존성 추가 + `/actuator/prometheus` 비공개 노출 설정
- [ ] prod에 **테스트용 모집 공고 1건 + 트랙별 질문 시드** (k6 조회 대상)
- [ ] 테스트 유저 ~300명 prod `users` 시드
- [ ] `application-loadtest.yml` 작성 (토큰 만료 연장) + 토큰 생성기 작성 → `tokens.csv`
- [ ] k6 스크립트 갱신 (§6)
- [ ] 로컬 Prometheus + Grafana docker 구성 (기존 `prometheus.yml` 타겟만 `localhost:9090`으로 수정)
- [ ] SSH 터널 동작 확인

---

## 8. 진행 절차

- **전**: 이 계획서 팀 공유 → 비동기 리뷰. prod 부하 테스트 시간대 사전 공지 (CloudWatch 알람이 울릴 수 있음)
- **중**: 솔로 실행. `load` → `stress` → `spike` 순. 각 런 사이 서버 안정화 대기
- **후**: 결과 문서 공유 — k6 요약 + Grafana 캡처 + 판정 + 인스턴스/설정 권고. 인스턴스 유형 결정은 팀이 함께

---

## 9. 일정 (6/1 오픈 역산)

| 날짜 | 작업 |
| --- | --- |
| 5/24~26 | 사전 준비 (§7) |
| 5/27~28 | 부하 테스트 실행 (솔로, prod) |
| 5/28~29 | 분석 + 결과 공유 + 튜닝 적용 (HikariCP 풀 등) |
| 5/29~31 | 시즌 전환 리허설 + (옵션) failover-under-load |
| 6/1 | 서비스 오픈 — 버퍼 확보 |

> 인스턴스 유형 변경 가능성이 있으므로 실행을 5/27~28로 앞당겨, 6/1 전에 변경을 반영할 여유를 둠.

---

## 10. 리스크 / 정리

| 항목 | 대응 |
| --- | --- |
| prod RDS 더미 오염 | `LOADTEST_*` 유저 + 지원서/임시저장 테스트 후 삭제 (admin `deleteApplicants` + SQL) |
| 재실행 시 `409` | `spike` 실행 후 테스트 유저는 `SUBMITTED` 상태 → 재실행 전 status 리셋 또는 유저 재시드 |
| k6 단일 IP 출발 | WAF rate-based rule이 있으므로 k6 실행 IP를 WAF 화이트리스트에 임시 등록 후 테스트, 완료 후 제거 |
| 부하 중 알람 발생 | 팀에 시간대 사전 공지 |
| 토큰 만료(15분) | 생성기에서 만료 연장(§5), 또는 테스트 직전 발급 |

---

## 관련 문서

- `aws-architecture.md` — 인프라 구성, 기존 부하 테스트 결론
- `cloudwatch-dashboard.md` — 상시 운영 모니터링 (부하 테스트와 별개)
- `deployment-checklist.md` — E "부하 테스트", C-2 시즌 전환 리허설
- `backend-load-test/k6-script/script.js` — 재사용할 기존 k6 스크립트
