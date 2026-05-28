# 부하 테스트 실행 가이드

> 계획서: `load-test-plan.md`
> 대상: 실행 담당자 (솔로 진행)

---

## 0. 사전 요구사항

로컬에 설치 필요:
- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) — `k6 version`으로 확인
- Docker Desktop — `docker compose version`으로 확인
- EC2 SSH 접근 가능한 키 파일 (`.pem`)

---

## 1단계. 백엔드 준비 (Spring Boot)

### 1-1. micrometer 의존성 추가

`backend/build.gradle`에 추가:

```groovy
implementation 'io.micrometer:micrometer-registry-prometheus'
```

### 1-2. application-loadtest.yml 작성

`backend/src/main/resources/application-loadtest.yml` 생성:

```yaml
jwt:
  access-token-expiration: 10800000  # 3시간 (기본 15분 → 테스트 윈도우 커버)
```

### 1-3. Actuator prometheus 엔드포인트 설정 확인

`application.yml`에 아래가 있는지 확인 (없으면 추가):

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health, prometheus
  endpoint:
    prometheus:
      enabled: true
```

> `/actuator/prometheus`는 외부에 노출하지 않음 — SSH 터널로만 접근.
> Spring Security에서 `/actuator/**`가 인증 없이 localhost에서만 접근 가능한지 확인.

### 1-4. 토큰 생성기 작성

`loadtest` 프로파일로 실행하는 일회성 `CommandLineRunner` 또는 테스트 클래스를 작성해 아래를 수행:

1. prod DB에서 `provider = 'TEST'`인 유저 300명의 `id`를 조회
2. `jwtProvider.generateUserAccessToken(userId)` 호출
3. `tokens.csv`로 덤프 (`userId,token` 형식)

```
# tokens.csv 예시
101,eyJhbGciOiJIUzI1NiJ9...
102,eyJhbGciOiJIUzI1NiJ9...
...
```

실행 방법:

```bash
# backend 디렉토리에서
./gradlew bootRun --args='--spring.profiles.active=prod,loadtest'
```

> `tokens.csv`는 `backend-load-test/k6-script/` 아래에 두면 k6 스크립트에서 상대경로로 읽을 수 있음.
> 커밋하지 말 것 — `.gitignore`에 `tokens.csv` 추가.

---

## 2단계. prod 데이터 시드

### 2-1. 테스트 유저 300명 시드

prod RDS에 SSH 터널 또는 bastion을 통해 접속 후 실행:

```sql
INSERT INTO users (provider, provider_id, email, name, created_at, updated_at)
SELECT
  'TEST',
  CONCAT('loadtest_', LPAD(seq, 3, '0')),
  CONCAT('loadtest_', LPAD(seq, 3, '0'), '@boaz.test'),
  CONCAT('부하테스트유저', seq),
  NOW(),
  NOW()
FROM (
  SELECT a.N + b.N * 10 + c.N * 100 + 1 AS seq
  FROM
    (SELECT 0 AS N UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
     UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a,
    (SELECT 0 AS N UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
     UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b,
    (SELECT 0 AS N UNION SELECT 1 UNION SELECT 2) c
) nums
WHERE seq <= 300;
```

삽입 후 id 범위 확인:

```sql
SELECT MIN(id), MAX(id), COUNT(*) FROM users WHERE provider = 'TEST';
```

### 2-2. 테스트 모집 공고 + 질문 시드

k6가 조회할 모집 공고 1건과 트랙별 질문을 시드. admin 페이지에서 직접 생성하거나 SQL로 insert.  
시드 후 `recruitmentId`와 각 질문의 `id`를 메모 → k6 스크립트에 하드코딩.

```sql
-- 시드 후 확인
SELECT id, title FROM recruitments ORDER BY id DESC LIMIT 1;
SELECT id, track, content FROM application_questions WHERE recruitment_id = {위에서 확인한 id};
```

---

## 3단계. k6 스크립트 갱신

`k6-script/script.js`를 `load-test-plan.md` §6 체크리스트에 따라 수정.  
핵심 변경 사항:

```js
import { SharedArray } from 'k6/data';

const BASE_URL = 'https://api.bigdataboaz.com/api/v1';
const RECRUITMENT_ID = 1; // 2-2에서 확인한 id로 교체

const tokens = new SharedArray('tokens', function () {
  return open('./tokens.csv').trim().split('\n')
    .slice(1) // 헤더 제거 (있을 경우)
    .map(line => line.split(',')[1]); // token 컬럼만
});

export default function () {
  const token = tokens[__VU - 1];
  const authHeaders = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  };

  // 조회 (100%)
  http.get(`${BASE_URL}/recruitment/status`);
  sleep(0.5);
  http.get(`${BASE_URL}/recruitment/questions?recruitmentId=${RECRUITMENT_ID}&track=ENGINEERING`);
  sleep(1);

  // 임시저장 반복 (load/stress — 15초 간격)
  while (true) {
    http.put(
      `${BASE_URL}/recruitment/${RECRUITMENT_ID}/applications/draft`,
      JSON.stringify(makeDraftPayload()),
      authHeaders
    );
    sleep(15);
  }
}
```

> `spike` 시나리오는 별도 함수로 분리하고 `per-vu-iterations` executor 사용 (VU당 제출 1회).

---

## 4단계. 모니터링 환경 구성

### 4-1. prometheus.yml 수정

`prometheus.yml`의 scrape target을 SSH 터널 포트로 변경:

```yaml
scrape_configs:
  - job_name: 'spring-boot'
    static_configs:
      - targets: ['host.docker.internal:9091']  # SSH 터널 포트
```

> Docker 컨테이너에서 로컬호스트에 접근할 때는 `localhost` 대신 `host.docker.internal` 사용.

### 4-2. Prometheus + Grafana docker-compose 추가

`docker-compose.yaml`에 prometheus/grafana 서비스 추가 또는 별도 파일 생성:

```yaml
# docker-compose.monitoring.yaml
version: '3.8'
services:
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"
    extra_hosts:
      - "host.docker.internal:host-gateway"

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    depends_on:
      - prometheus
```

---

## 5단계. 실행

### 5-1. SSH 터널 열기 (터미널 1 — 테스트 내내 유지)

```bash
ssh -i <키파일.pem> -L 9091:localhost:8080 ec2-user@<EC2-PUBLIC-IP> -N
```

> `-N`: 명령 실행 없이 터널만 유지. 연결 확인: `curl http://localhost:9091/actuator/prometheus`

### 5-2. Prometheus + Grafana 기동 (터미널 2)

```bash
docker compose -f docker-compose.monitoring.yaml up -d
```

- Prometheus: http://localhost:9090 → Status > Targets에서 `spring-boot` UP 확인
- Grafana: http://localhost:3000 (admin/admin)
  - Data source 추가: Prometheus → `http://prometheus:9090`
  - JVM 대시보드 import: Grafana 대시보드 ID `4701` (JVM Micrometer)

### 5-3. load 시나리오 실행 (터미널 3)

```bash
cd k6-script
k6 run -e TYPE=load script.js
```

완료 후 서버 안정화 대기 (약 2분). CloudWatch에서 CPU/커넥션이 기준선으로 복귀한 것 확인.

### 5-4. stress 시나리오 실행

```bash
k6 run -e TYPE=stress script.js
```

완료 후 동일하게 안정화 대기.

### 5-5. spike 시나리오 실행

```bash
k6 run -e TYPE=spike script.js
```

> spike는 제출이 포함되므로 **한 번만 실행**. 재실행이 필요하면 테스트 유저 지원 상태를 초기화하거나 유저를 재시드해야 함.

---

## 6단계. 결과 수집

k6 실행이 끝나면 터미널에 요약이 출력됨. 별도 파일로 저장:

```bash
k6 run -e TYPE=stress --summary-export=results/stress-summary.json script.js
```

수집할 항목:
- k6 터미널 출력 스크린샷 또는 `--summary-export` JSON
- Grafana 대시보드 캡처 — JVM 힙, GC, HTTP 처리량
- CloudWatch 캡처 — EC2 CPU, RDS DatabaseConnections, RDS CPU

**판정 체크 (§2 합격선 기준):**

```
[ ] http_req_duration p95 < 1s
[ ] http_req_failed < 1%
[ ] RDS DatabaseConnections < 50
[ ] EC2/RDS CPU 지속 80% 미만
[ ] JVM 힙 정상 회수
```

---

## 7단계. 정리 (테스트 완료 후 필수)

### 7-1. 테스트 데이터 삭제

```sql
-- 임시저장 데이터 삭제
DELETE FROM applicant_answers
WHERE applicant_id IN (
  SELECT a.id FROM applicants a
  JOIN users u ON a.user_id = u.id
  WHERE u.provider = 'TEST'
);

DELETE FROM applicants
WHERE user_id IN (SELECT id FROM users WHERE provider = 'TEST');

-- 테스트 유저 삭제
DELETE FROM users WHERE provider = 'TEST';
```

### 7-2. 테스트 모집 공고 삭제

admin 페이지 또는 SQL로 테스트용 공고 삭제.

### 7-3. tokens.csv 삭제

```bash
rm k6-script/tokens.csv
```

### 7-4. 모니터링 컨테이너 종료

```bash
docker compose -f docker-compose.monitoring.yaml down
```

### 7-5. WAF 화이트리스트 제거

k6 실행 IP를 WAF에 임시 등록했다면 제거.

---

## 결과 문서 작성

테스트 완료 후 결과를 `results/` 폴더에 정리:

```
backend-load-test/
  results/
    load-summary.json
    stress-summary.json
    spike-summary.json
    grafana-jvm-load.png
    grafana-jvm-stress.png
    cloudwatch-rds-connections.png
    findings.md          ← 판정 + 권고사항 요약
```

`findings.md`에 포함할 내용:
- 각 시나리오 판정 결과 (합격/불합격)
- 병목 지점 (있다면)
- 권고사항: 인스턴스 유형 유지/변경, HikariCP 풀 크기 조정 여부
