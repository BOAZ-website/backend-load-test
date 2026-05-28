import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { SharedArray } from 'k6/data';

// ─── 토큰 로드 ───────────────────────────────────────────────────────────────
const tokens = new SharedArray('tokens', function () {
  return open('./tokens.csv').trim().split('\n')
    .slice(1)                        // 헤더(userId,token) 제거
    .map(line => line.split(',')[1]); // token 컬럼만
});

// ─── 시나리오 ────────────────────────────────────────────────────────────────
const scenarios = {
  load: {
    executor: 'ramping-vus',
    stages: [
      { duration: '1m', target: 50 },
      { duration: '3m', target: 50 },
      { duration: '1m', target: 0 },
    ],
  },
  stress: {
    executor: 'ramping-vus',
    stages: [
      { duration: '1m', target: 100 },
      { duration: '2m', target: 200 },
      { duration: '3m', target: 300 },
      { duration: '2m', target: 150 },
      { duration: '1m', target: 0 },
    ],
  },
  spike: {
    // 제출은 VU당 1회 — Applicant.user_id UNIQUE 제약 및 ALREADY_SUBMITTED 방지
    executor: 'per-vu-iterations',
    vus: 300,
    iterations: 1,
    maxDuration: '3m',
  },
};

export const options = {
  scenarios: {
    default: scenarios[__ENV.TYPE] || scenarios.load,
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

// ─── 공통 설정 ───────────────────────────────────────────────────────────────
const BASE_URL = 'https://api.bigdataboaz.com/api/v1';

// recruitment id=1 (term 26, 2026-05-01 ~ 2026-05-31) — 현재 모집 중
// ⚠️ isActive 체크 있음: getQuestions/saveDraft/submitApplication 모두 기간 내에만 동작
const RECRUITMENT_ID = 1;

// ENGINEERING 트랙 질문 IDs (recruitment_id=1)
// 공통 TEXT 필수: 1,2,3,4 / 선택: 5
// 엔지니어링 TABLE 필수: 10 / TEXT 필수: 11,12
const REQUIRED_TEXT_IDS  = [1, 2, 3, 4, 11, 12];
const OPTIONAL_TEXT_ID   = 5;
const TABLE_QUESTION_ID  = 10;

// ─── payload 빌더 ────────────────────────────────────────────────────────────
function buildAnswers() {
  const answers = [];

  // 공통 필수 TEXT (500자 이내 → 200자 정도로)
  for (const qid of REQUIRED_TEXT_IDS) {
    answers.push({ question_id: qid, answer: '테스트 답변 내용입니다. '.repeat(10).slice(0, 200) });
  }

  // 공통 선택 TEXT
  answers.push({ question_id: OPTIONAL_TEXT_ID, answer: 'https://github.com/loadtest' });

  // 엔지니어링1 TABLE — non-empty JSON object 이어야 함 (서버: isObject() && size() > 0)
  // rows: 경험 항목, columns: 경험 수준
  answers.push({
    question_id: TABLE_QUESTION_ID,
    answer: {
      "데이터베이스(관계형 DB, NoSQL 등)":               "관련 프로젝트 경험 있음",
      "서버 및 클라우드 서비스(Linux, Docker, AWS 등)":  "관련 프로젝트 경험 있음",
      "데이터 엔지니어링 오픈 소스(Spark, Kafka 등)":    "경험 없음",
      "컨테이너 오케스트레이션 도구(Kubernetes 등)":     "경험 없음",
      "언어(Python, Java, Scala 중 1)":                "관련 프로젝트 경험 있음",
    },
  });

  return answers;
}

function buildPayload() {
  // VU 번호 기반 고유 이메일/전화번호 — draft는 upsert라 반복 호출해도 동일 레코드 업데이트
  const vu = String(__VU).padStart(3, '0');
  return JSON.stringify({
    track:              'ENGINEERING',
    name:               `부하테스트유저${vu}`,
    email:              `loadtest${vu}@boaz.test`,    // 형식: ^[A-Za-z0-9+_.-]+@[A-Za-z0-9.-]+$
    phone:              `0100000${vu}`,                // 10자리: ^[0-9]{10,11}$ (010 + 0000 + 001~300)
    university:         '숙명여자대학교',
    major:              '컴퓨터과학',
    minor_double_major: [],
    last_semester:      4,
    military_status:    'COMPLETED_OR_EXEMPT',
    birth_date:         '2002-08-03',                 // YYYY-MM-DD
    graduation_date:    '2027-02',
    grad_school_plan:   false,
    answers:            buildAnswers(),
  });
}

// ─── 메인 로직 ───────────────────────────────────────────────────────────────
export default function () {
  const token = tokens[(__VU - 1) % tokens.length];
  const authHeaders = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  };
  const type = __ENV.TYPE || 'load';

  // ── spike: 조회 → 최종 제출 1회 ─────────────────────────────────────────
  // ⚠️ spike는 load/stress 이후에만 실행할 것
  //    SUBMITTED 상태가 되면 같은 유저로 draft도 불가 (APPLICATION_ALREADY_SUBMITTED)
  if (type === 'spike') {
    group('조회', function () {
      const res = http.get(`${BASE_URL}/recruitment/status`);
      check(res, { 'status 200': (r) => r.status === 200 });
    });

    sleep(0.5);

    group('최종 제출 (1회)', function () {
      // DRAFT → SUBMITTED 전환 or 신규 SUBMITTED 생성
      // 이미 SUBMITTED면 409 ALREADY_SUBMITTED → http_req_failed 오염 주의
      const res = http.post(
        `${BASE_URL}/recruitment/${RECRUITMENT_ID}/applications`,
        buildPayload(),
        authHeaders
      );
      check(res, { 'submit 200/201': (r) => r.status === 200 || r.status === 201 });
    });

    return;
  }

  // ── load / stress: 조회 → 양식 → 임시저장 반복 (15초 주기) ───────────────
  group('1. 모집 상태 조회', function () {
    const res = http.get(`${BASE_URL}/recruitment/status`);
    check(res, { 'status 200': (r) => r.status === 200 });
  });

  sleep(0.5);

  group('2. 지원서 양식 조회', function () {
    // isActive 체크 있음 — RECRUITMENT_ID=1 기간 내에만 200 반환
    const res = http.get(
      `${BASE_URL}/recruitment/questions?recruitmentId=${RECRUITMENT_ID}&track=ENGINEERING`
    );
    check(res, { 'questions 200': (r) => r.status === 200 });
  });

  sleep(1);

  group('3. 임시저장 (auto-sync)', function () {
    // upsert: 없으면 DRAFT 생성, 있으면 업데이트
    // SUBMITTED 유저는 APPLICATION_ALREADY_SUBMITTED(409) → spike 후엔 이 그룹 에러 발생
    const res = http.put(
      `${BASE_URL}/recruitment/${RECRUITMENT_ID}/applications/draft`,
      buildPayload(),
      authHeaders
    );
    check(res, { 'draft 200': (r) => r.status === 200 });
  });

  sleep(15); // 프론트 15초 auto-sync 주기
}
