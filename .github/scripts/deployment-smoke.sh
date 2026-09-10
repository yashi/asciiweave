#!/usr/bin/env bash
set -euo pipefail

url="${SMOKE_TEST_URL:-${DEPLOYMENT_URL:-}}"
headers=()
if [ "${SMOKE_TEST_ACCESS:-false}" = true ]; then
  headers=(-H "CF-Access-Client-Id: $ACCESS_ID"
           -H "CF-Access-Client-Secret: $ACCESS_SECRET")
fi

for i in $(seq 1 10); do
  # A successful HTTP response can still come from the previous Worker.
  if body=$(curl -sf --connect-timeout 5 --max-time 10 "${headers[@]}" "$url/api/health") &&
    jq -e --arg commit "$DEPLOYED_COMMIT" \
      '.ok == true and .commit == $commit' <<< "$body" > /dev/null 2>&1; then
    echo "Deployed commit $DEPLOYED_COMMIT to $url" >> "$GITHUB_STEP_SUMMARY"
    exit 0
  fi
  echo "Health check attempt $i/10 did not confirm commit $DEPLOYED_COMMIT"
  if [ "$i" -lt 10 ]; then
    sleep 3
  fi
done

echo "::error::Health check did not confirm commit $DEPLOYED_COMMIT at $url"
exit 1
