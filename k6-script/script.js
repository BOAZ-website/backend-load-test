import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { SharedArray } from 'k6/data';

// ─── 토큰 로드 (2단계 시드 후 1-4 토큰 생성기로 만든 파일) ──────────────────
const tokens = new SharedArray('tokens', function () {
  return open('./tokens.csv').trim().split('\n')
    .slice(1) // 헤더(userId,token) 제거
    .map(line => line.split(',')[1]);
});

// ─── 시나리오 설정 ──────────────────────────────────────────────────────────
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
    // 제출은 VU당 1회만 — 409 오염 방지
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

// TODO: 2-2 시드 후 실제 id로 교체
const RECRUITMENT_ID = 1;
// TODO: 2-2 시드 후 실제 question_id로 교체
const QUESTION_IDS = { q1: 1, q2: 2, q3: 3 };

// ─── payload 빌더 ────────────────────────────────────────────────────────────
function buildPayload() {
  return JSON.stringify({
    track: 'ENGINEERING',
    name: `부하테스트유저${__VU}`,
    email: `loadtest_${String(__VU).padStart(3, '0')}@boaz.test`,
    phone: `010${String(10000000 + __VU).slice(1)}`,
    university: '숙명여자대학교',
    major: '컴퓨터과학',
    minor_double_major: [],
    last_semester: 4,
    military_status: 'COMPLETED_OR_EXEMPT',
    birth_date: '2002-08-03',
    graduation_date: '2027-02',
    grad_school_plan: false,
    answers: [
      { question_id: QUESTION_IDS.q1, answer: '테스트 답변입니다. '.repeat(10) },
      { question_id: QUESTION_IDS.q2, answer: '테스트 답변입니다. '.repeat(10) },
      { question_id: QUESTION_IDS.q3, answer: '테스트 답변입니다. '.repeat(10) },
    ],
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

  // spike: 조회 1회 → 최종 제출 1회
  if (type === 'spike') {
    group('조회', function () {
      const res = http.get(`${BASE_URL}/recruitment/status`);
      check(res, { 'status 200': (r) => r.status === 200 });
    });
    sleep(0.5);
    group('최종 제출 (1회)', function () {
      const res = http.post(
        `${BASE_URL}/recruitment/${RECRUITMENT_ID}/applications`,
        buildPayload(),
        authHeaders
      );
      check(res, { 'submit 200/201': (r) => r.status === 200 || r.status === 201 });
    });
    return;
  }

  // load / stress: 조회 → 양식 확인 → 임시저장 반복 (15초 간격)
  group('1. 모집 상태 조회', function () {
    const res = http.get(`${BASE_URL}/recruitment/status`);
    check(res, { 'status 200': (r) => r.status === 200 });
  });

  sleep(0.5);

  group('2. 지원서 양식 조회', function () {
    const res = http.get(
      `${BASE_URL}/recruitment/questions?recruitmentId=${RECRUITMENT_ID}&track=ENGINEERING`
    );
    check(res, { 'questions 200': (r) => r.status === 200 });
  });

  sleep(1);

  group('3. 임시저장 (auto-sync)', function () {
    const res = http.put(
      `${BASE_URL}/recruitment/${RECRUITMENT_ID}/applications/draft`,
      buildPayload(),
      authHeaders
    );
    check(res, { 'draft 200': (r) => r.status === 200 });
  });

  sleep(15); // 프론트 15초 auto-sync 주기
}
