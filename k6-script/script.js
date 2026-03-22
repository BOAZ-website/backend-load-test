import http from 'k6/http';
import { check, sleep, group } from 'k6';

// 1. 시나리오별 옵션 설정
const scenarios = {
  load: { // 일반 부하 테스트
    executor: 'ramping-vus',
    stages: [
      { duration: '1m', target: 50 },
      { duration: '3m', target: 50 },
      { duration: '1m', target: 0 },
    ],
  },
  stress: { // 마감 직전 스트레스 테스트
    executor: 'ramping-vus',
    stages: [
      { duration: '1m', target: 100 },
      { duration: '2m', target: 200 },
      { duration: '3m', target: 300 },
      { duration: '2m', target: 150 },
      { duration: '1m', target: 0 },
    ],
  },
  spike: { // 순간 폭발 스파이크 테스트
    executor: 'ramping-vus',
    stages: [
      { duration: '30s', target: 300 },
      { duration: '2m', target: 0 },
    ],
  }
};

// 실행 시 입력받은 TYPE 환경변수에 따라 옵션 결정 (기본값: load)
export const options = {
  scenarios: {
    default: scenarios[__ENV.TYPE] || scenarios.load,
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'], // 95%의 요청은 1초 미만
    http_req_failed: ['rate<0.01'],    // 에러율 1% 미만 유지
  },
};

const BASE_URL = 'https://dev.bigdataboaz.com/api/v1';

// 2. 더미 데이터 생성 함수
function makeApplicantPayload() {
  const uniqueId = `${__VU}_${__ITER}`;

  return {
    recruitment_id: 1,
    track: '엔지니어링',
    name: `LOADTEST_USER_${uniqueId}`,
    email: `loadtest_${uniqueId}@boaz.test`,
    // 전화번호 중복 방지 (010 + 8자리 숫자 조합)
    phone: `010${String(uniqueId).replace('_', '').padEnd(8, '1').slice(0, 8)}`,
    university: '숙명여자대학교',
    major: '컴퓨터과학',
    minor_double_major: ['데이터사이언스'],
    last_semester: 3, // 예시와 동일하게 수정
    military_status: '필_또는_면제', // 예시와 동일하게 수정
    birth_date: '2002-08-03', // 예시와 동일하게 수정
    graduation_date: '2027-02',
    grad_school_plan: true,
    answers: [
      { 
        question_id: '공통1', 
        answer: '테스트 답변 내용입니다. '.repeat(10) 
      },
      { 
        question_id: '공통2', 
        answer: '테스트 답변 내용입니다. '.repeat(10) 
      },
      { 
        question_id: '공통5', 
        answer: '테스트 답변 내용입니다. '.repeat(10) 
      },
      { 
        question_id: '엔지니어링1', 
        // 중요: 문자열이 아닌 '객체' 형태로 직접 넣어야 합니다.
        answer: {
          rows: ["데이터베이스", "서버 및 클라우드 서비스"],
          columns: ["경험 없음", "관련 프로젝트 경험 있음"]
        }
      },
      { 
        question_id: '엔지니어링2', 
        answer: '전공 역량 답변 내용입니다. '.repeat(15) 
      }
    ],
  };
}

// 3. 메인 테스트 로직
export default function () {
  const rand = Math.random();

  group('1. 메인 및 상세 조회 (100%)', function () {
    let res = http.get(`${BASE_URL}/recruitment/status`);
    check(res, { 'recruitment status 200': (r) => r.status === 200 });
    
    sleep(0.5);

    res = http.get(`${BASE_URL}/recruitment/26`);
    check(res, { 'recruitment detail 200': (r) => r.status === 200 });
  });

  // 조회형 유저(30%) 이탈 시뮬레이션
  // if (rand < 0.3) return; 

  sleep(1);

  group('2. 지원서 양식 확인 (70%)', function () {
    let res = http.get(`${BASE_URL}/recruitment/questions?recruitmentId=1&track=%EC%97%94%EC%A7%80%EB%8B%88%EC%96%B4%EB%A7%81`);
    check(res, { 'questions 200': (r) => r.status === 200 });
  });

  // 단순 확인형 유저(20%) 추가 이탈 -> 최종 50%만 제출 단계 진입
  // if (rand < 0.5) return;

  sleep(2); // 실제 지원서 작성 시간을 고려한 긴 대기

  group('3. 지원서 최종 제출 (50%)', function () {
    const payload = makeApplicantPayload();
    let res = http.post(
      `${BASE_URL}/recruitment/applications`,
      JSON.stringify(payload),
      { headers: { 'Content-Type': 'application/json' } }
    );

    check(res, {
      'submit success (200/201)': (r) => r.status === 200 || r.status === 201,
    });
  });

  sleep(1);
}