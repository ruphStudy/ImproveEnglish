#!/bin/bash
# Real-time Webhook Log Monitor

echo "🔍 Real-Time Webhook Monitor - Press Ctrl+C to stop"
echo "=================================================="
echo ""

while true; do
  clear
  echo "🔍 WEBHOOK LOGS - Updated: $(date +%H:%M:%S)"
  echo "=================================================="
  echo ""
  
  # Show last 15 logs
  curl -s http://localhost:3000/api/logs | python3 -c "
import sys, json
try:
    logs = json.load(sys.stdin)
    for i, log in enumerate(logs[:15]):
        log_type = log.get('type', 'UNKNOWN')
        phone = log.get('phone', 'N/A')
        message = log.get('message', 'N/A')
        
        # Color coding
        if log_type == 'MESSAGE_RECEIVED':
            icon = '📨'
        elif log_type == 'LESSON_STARTED':
            icon = '🚀'
        elif log_type == 'LESSON_COMPLETED':
            icon = '🎉'
        elif log_type == 'ERROR':
            icon = '❌'
        else:
            icon = '📝'
        
        print(f'{icon} [{log_type}]')
        print(f'   Phone: {phone}')
        print(f'   {message[:80]}')
        print('')
except:
    print('❌ Could not fetch logs')
" 2>/dev/null || echo "⚠️ Backend not responding"
  
  echo "=================================================="
  echo "💡 Send a WhatsApp message now to see it appear here!"
  sleep 2
done
