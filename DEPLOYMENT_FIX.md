# Frontend Deployment Fix for SPA Routing

## Problem
When you visit `https://www.fluencyloop.in/buy` directly, it shows the dashboard or 404 instead of the payment page.

## Root Cause
Single Page Applications (SPA) like React need the server to serve `index.html` for ALL routes. The server currently doesn't know about React Router's client-side routes.

## Solution: Configure Your Web Server

### Option 1: Nginx (Recommended for VPS/Dedicated Server)

1. **Edit your nginx config** (usually at `/etc/nginx/sites-available/fluencyloop.in`):

```nginx
server {
    listen 80;
    server_name fluencyloop.in www.fluencyloop.in;

    root /path/to/your/frontend/dist;
    index index.html;

    # THIS IS THE KEY LINE - serve index.html for all routes
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API requests to backend
    location /api {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

2. **Test and reload nginx**:
```bash
sudo nginx -t
sudo systemctl reload nginx
```

### Option 2: Apache (.htaccess)

1. **Copy the `.htaccess` file** I created to your `frontend/dist` folder AFTER building

2. **Make sure mod_rewrite is enabled**:
```bash
sudo a2enmod rewrite
sudo systemctl restart apache2
```

### Option 3: Vercel (if hosting on Vercel)

The `vercel.json` file I created will automatically handle this. Just commit and push:
```bash
git add frontend/vercel.json
git commit -m "Add Vercel SPA routing config"
git push
```

### Option 4: Netlify (if hosting on Netlify)

The `netlify.toml` file I created will automatically handle this. Just commit and push:
```bash
git add frontend/netlify.toml
git commit -m "Add Netlify SPA routing config"
git push
```

## After Configuration

1. **Rebuild your frontend**:
```bash
cd frontend
npm run build
```

2. **Copy built files to your server** (if using VPS):
```bash
# The dist folder should be copied to your nginx/apache root directory
```

3. **Test the routes**:
- Visit: https://www.fluencyloop.in/buy (should show payment page)
- Visit: https://www.fluencyloop.in/privacy-policy (should show privacy page)
- Visit: https://www.fluencyloop.in (should show admin dashboard)

## Quick Test
After applying the config, try these URLs directly in browser:
- ✅ `https://www.fluencyloop.in/buy` → Payment Page
- ✅ `https://www.fluencyloop.in/terms` → Terms Page
- ✅ `https://www.fluencyloop.in/privacy-policy` → Privacy Page
- ✅ `https://www.fluencyloop.in/contact` → Contact Page

## Still Not Working?

Check these:
1. **Clear browser cache** (Ctrl+Shift+R or Cmd+Shift+R)
2. **Check server logs** for 404 errors
3. **Verify the dist folder** has the latest build
4. **Check if server config is actually applied** (restart server)
5. **Confirm the build is up to date** (run `npm run build` again)

## Which Web Server Are You Using?
Let me know if you're using:
- [ ] Nginx
- [ ] Apache
- [ ] Vercel
- [ ] Netlify
- [ ] Other: ____________

And I can provide more specific instructions!
