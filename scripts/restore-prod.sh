#!/bin/bash
set -e

HOSTS=("boaz-api-prod-A" "boaz-api-prod-B")

echo "=== prod 복구 시작 ==="

for HOST in "${HOSTS[@]}"; do
    echo ""
    echo "=== [$HOST] 복구 ==="

    ssh "$HOST" bash <<'REMOTE'
set -e
if [ ! -f /opt/boaz/app-prod-backup.jar ]; then
    echo "[ERROR] 백업 jar 없음 (/opt/boaz/app-prod-backup.jar). CI/CD 재배포로 복구하세요."
    exit 1
fi

sudo cp -f /opt/boaz/app-prod-backup.jar          /opt/boaz/app.jar
sudo cp -f /opt/boaz/scripts/start-prod-backup.sh /opt/boaz/scripts/start.sh
sudo chown boaz:boaz /opt/boaz/app.jar /opt/boaz/scripts/start.sh

sudo systemctl restart boaz
sleep 8
sudo systemctl is-active boaz

sudo rm -f /opt/boaz/app-prod-backup.jar /opt/boaz/scripts/start-prod-backup.sh
echo "  백업 파일 정리 완료"
REMOTE

    echo "  [$HOST] 복구 완료"
done

echo ""
echo "=============================="
echo " prod 복구 완료"
echo "=============================="
echo ""
echo "잊지 말고 정리:"
echo "  - docker compose -f docker-compose.monitoring.yaml down"
echo "  - rm k6-script/tokens.csv"
echo "  - prod DB 테스트 데이터 삭제 (가이드 7단계)"
