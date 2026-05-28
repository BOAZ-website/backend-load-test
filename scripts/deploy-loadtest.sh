#!/bin/bash
set -e

PEM="$HOME/.ssh/boaz_codedeploy.pem"
SSH_OPTS="-i $PEM -o StrictHostKeyChecking=no"
HOSTS=("ubuntu@15.165.102.5" "ubuntu@43.201.105.117")

JAR=$(ls build/libs/*.jar 2>/dev/null | grep -v plain | head -1)

if [ -z "$JAR" ]; then
    echo "[ERROR] build/libs/ 에 jar가 없습니다."
    echo "  먼저 빌드를 실행하세요: ./gradlew build -x test"
    exit 1
fi

echo "배포할 jar: $JAR"

for HOST in "${HOSTS[@]}"; do
    echo ""
    echo "=== [$HOST] 배포 ==="

    echo "  jar 전송..."
    scp $SSH_OPTS "$JAR" "$HOST:/tmp/app-loadtest.jar"

    echo "  start-loadtest.sh 전송..."
    scp $SSH_OPTS scripts/start-loadtest.sh "$HOST:/tmp/start-loadtest.sh"

    echo "  원본 백업 → 교체 → 서비스 재시작..."
    ssh $SSH_OPTS "$HOST" bash <<'REMOTE'
set -e
sudo cp -f /opt/boaz/app.jar              /opt/boaz/app-prod-backup.jar
sudo cp -f /opt/boaz/scripts/start.sh     /opt/boaz/scripts/start-prod-backup.sh

sudo cp -f /tmp/app-loadtest.jar          /opt/boaz/app.jar
sudo cp -f /tmp/start-loadtest.sh         /opt/boaz/scripts/start.sh
sudo chmod +x /opt/boaz/scripts/start.sh
sudo chown boaz:boaz /opt/boaz/app.jar /opt/boaz/scripts/start.sh

sudo systemctl restart boaz
sleep 8
sudo systemctl is-active boaz
REMOTE

    echo "  [$HOST] 완료"
done

echo ""
echo "=============================="
echo " 부하 테스트 배포 완료"
echo "=============================="
echo ""
echo "다음 단계:"
echo "  1. 토큰 생성:"
echo "     ./gradlew test --tests 'com.boaz.backend.loadtest.TokenGenerator.generateTokens'"
echo ""
echo "  2. script.js에서 RECRUITMENT_ID / QUESTION_IDS 실제 값으로 교체"
echo ""
echo "  3. SSH 터널 (터미널 별도):"
echo "     ssh -L 9091:localhost:8080 boaz-api-prod-A -N"
echo "     확인: curl http://localhost:9091/actuator/prometheus"
echo ""
echo "  4. 모니터링 기동:"
echo "     docker compose -f docker-compose.monitoring.yaml up -d"
echo ""
echo "  5. k6 실행:"
echo "     cd k6-script && k6 run -e TYPE=load script.js"
