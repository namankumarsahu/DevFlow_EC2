#!/usr/bin/env bash
# Stop containers (builds and user apps) from reaching the cloud metadata service at 169.254.169.254.
# On EC2 that address hands out the instance's IAM credentials, so a hostile build or app must not see it.
# Run once on the host as root:  sudo ./scripts/block-metadata.sh
set -euo pipefail

# DOCKER-USER is the chain Docker reserves for your own forwarding rules; Docker never flushes it.
if ! iptables -C DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null; then
  iptables -I DOCKER-USER -d 169.254.169.254 -j DROP
  echo "Added rule: drop container traffic to 169.254.169.254"
else
  echo "Rule already present"
fi

cat <<'MSG'

This rule is lost on reboot. To keep it:  sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save

Also (recommended, EC2): require IMDSv2 so even the host side is harder to abuse:
  aws ec2 modify-instance-metadata-options --instance-id <id> --http-tokens required --http-put-response-hop-limit 1

Check it works (should time out, not print credentials):
  docker run --rm curlimages/curl -m 3 http://169.254.169.254/latest/meta-data/ || echo blocked
MSG
