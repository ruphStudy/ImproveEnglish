/**
 * Google Apps Script for Google Form Submission
 * 
 * HOW TO SET UP:
 * 1. Open your Google Form
 * 2. Click on the 3 dots menu (top right) > Script editor
 * 3. Delete any existing code and paste this script
 * 4. Replace YOUR_BACKEND_URL with your actual backend URL (MUST be public, not localhost)
 * 5. Save the script (Ctrl+S or Cmd+S)
 * 6. Click on the clock icon (Triggers) on the left sidebar
 * 7. Click "+ Add Trigger" (bottom right)
 * 8. Configure:
 *    - Choose which function to run: onFormSubmit
 *    - Select event source: From form
 *    - Select event type: On form submit
 * 9. Click "Save"
 * 10. Grant permissions when prompted
 * 
 * IMPORTANT NOTES:
 * - localhost URLs won't work from Google's servers - use ngrok, Railway, Render, etc.
 * - Make sure your backend accepts POST requests from any origin (CORS enabled)
 */

function onFormSubmit(e) {
  try {
    // Log the entire event object for debugging
    Logger.log('Event object: ' + JSON.stringify(e));
    
    var name, phone, email;
    
    // Method 1: Try using e.namedValues (works with form submit triggers)
    if (e.namedValues) {
      Logger.log('Using namedValues method');
      
      // Get form field names from your Google Form
      // Adjust these field names to match YOUR form's question text exactly
      var nameKey = Object.keys(e.namedValues)[0];  // First question
      var phoneKey = Object.keys(e.namedValues)[1]; // Second question
      var emailKey = Object.keys(e.namedValues)[2]; // Third question (if exists)
      
      name = e.namedValues[nameKey] ? e.namedValues[nameKey][0] : '';
      phone = e.namedValues[phoneKey] ? e.namedValues[phoneKey][0] : '';
      email = e.namedValues[emailKey] ? e.namedValues[emailKey][0] : '';
      
      Logger.log('Name: ' + name);
      Logger.log('Phone: ' + phone);
      Logger.log('Email: ' + email);
    } 
    // Method 2: Try using e.values (works with spreadsheet-based triggers)
    else if (e.values && e.values.length > 0) {
      Logger.log('Using values method');
      // e.values[0] is timestamp
      name = e.values[1];   // Name field
      phone = e.values[2];  // Phone field
      email = e.values[3];  // Email field (if exists)
      
      Logger.log('Name: ' + name);
      Logger.log('Phone: ' + phone);
      Logger.log('Email: ' + email);
    } 
    // Method 3: Direct response access
    else if (e.response) {
      Logger.log('Using response method');
      var itemResponses = e.response.getItemResponses();
      name = itemResponses[0].getResponse();
      phone = itemResponses[1].getResponse();
      email = itemResponses.length > 2 ? itemResponses[2].getResponse() : '';
      
      Logger.log('Name: ' + name);
      Logger.log('Phone: ' + phone);
      Logger.log('Email: ' + email);
    }
    
    // Validate required fields
    if (!name || !phone) {
      Logger.log('ERROR: Name or phone is missing!');
      return;
    }
    
    // Prepare data to send
    var data = {
      name: name,
      phone: phone
    };
    
    // Add email if present (optional field)
    if (email) {
      data.email = email;
    }
    
    Logger.log('Data to send: ' + JSON.stringify(data));
    
    // API endpoint - Your ngrok public URL
    // ✅ Current active URL (updated)
    var url = 'https://9ea7-2402-e280-3e1a-f2-2cdd-7c6e-69b6-fe3d.ngrok-free.app/api/register';
    
    // Configure the HTTP request
    var options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(data),
      muteHttpExceptions: true  // Don't throw errors on non-200 responses
    };
    
    // Send request to backend
    Logger.log('Sending request to: ' + url);
    var response = UrlFetchApp.fetch(url, options);
    var responseCode = response.getResponseCode();
    var responseBody = response.getContentText();
    
    // Log the response
    Logger.log('Response Code: ' + responseCode);
    Logger.log('Response Body: ' + responseBody);
    
    if (responseCode === 201 || responseCode === 200) {
      Logger.log('✅ User registered successfully!');
    } else {
      Logger.log('❌ Registration failed: ' + responseBody);
    }
    
  } catch (error) {
    // Log any errors with full details
    Logger.log('❌ Error in onFormSubmit: ' + error.toString());
    Logger.log('Error stack: ' + error.stack);
  }
}

/**
 * Optional: Test function to verify your setup
 * Run this function manually to test without submitting the form
 */
function testRegistration() {
  var testData = {
    name: 'Test User',
    phone: '+919876543210'
  };
  
  var url = 'https://9ea7-2402-e280-3e1a-f2-2cdd-7c6e-69b6-fe3d.ngrok-free.app/api/register';
  
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(testData),
    muteHttpExceptions: true
  };
  
  try {
    var response = UrlFetchApp.fetch(url, options);
    Logger.log('Test Response: ' + response.getContentText());
  } catch (error) {
    Logger.log('Test Error: ' + error.toString());
  }
}
