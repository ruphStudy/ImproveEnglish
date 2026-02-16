# Testing User Registration

## Using cURL

### Register a new user
```bash
curl -X POST http://localhost:3000/api/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe",
    "phone": "+919876543210"
  }'
```

Expected Response:
```json
{
  "success": true,
  "message": "User registered successfully",
  "user": {
    "name": "John Doe",
    "phone": "+919876543210",
    "state": "READY"
  }
}
```

## Using Postman

1. Create a new POST request
2. URL: `http://localhost:3000/api/register`
3. Headers: 
   - `Content-Type: application/json`
4. Body (raw JSON):
```json
{
  "name": "John Doe",
  "phone": "+919876543210"
}
```

## Verify in Database

After registration, check your MongoDB:
```bash
# Connect to MongoDB
mongosh

# Switch to database
use english-lesson-automation

# View registered users
db.users.find().pretty()

# View logs
db.logs.find().pretty()
```

## Testing from Google Apps Script

Use the `testRegistration()` function in `google-apps-script.js`:
1. Open Google Apps Script editor
2. Select `testRegistration` from the function dropdown
3. Click Run
4. Check View > Logs for results
