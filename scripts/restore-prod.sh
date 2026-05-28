#!/bin/bash
set -e

PEM="$HOME/.ssh/boaz_codedeploy.pem"
SSH_OPTS="-i $PEM -o StrictHostKeyChecking=no"
HOSTS=("ubuntu@15.165.102.5" "ubuntu@13.209.22.109")

echo "=== prod 복구 시작 ==="

for HOST in "${HOSTS[@]}"; do
    echo ""
    echo "=== [$HOST] 복구 ==="

    ssh $SSH_OPTS "$HOST" bash <<'REMOTE'
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
