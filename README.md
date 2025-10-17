### There are 3 versions of this Discord Bot

# Features
- Updates every 30 seconds
- Sends a filler message if nothing changes
- Will @everyone once it detects a change in the attendance quizzes

# Stack (all versions)
### - Python
### - Node.js
### - Cloudflare
### - Wrangler (with Cloudflare)
### - HTML + CSS
### - JavaScript
### - TypeScript

# v1: Python
- Uses requests to view changes that occur at the given endpoint for Canvas quizes

# v2: Node.js
- Simply fetch()'s the given endpoints to view changes that occur

# v3: Cloudflare Worker (TypeScript)
- Same approach as **Node.js** for determining changes
- Connects with a front end that allows for starting, stopping, and viewing the status of the bot.

## Endpoints

### /
- Home page with main UI
- Includes *start, stop, status* buttons
- Includes *status* description
- Includes *cookie* input and allows for copying saved cookies

### /start
- Only for POST method
- Requires cookies in *body*
- Starts the bot and 30 second (default) timer state

### /stop
- Only for POST method
- *Does not* require cookies
- Stops the bot and timer state

### /status
- Returns *JSON*
- Includes the next alarm's time, current canvas cookie in use, and whether there are cookies in use

Example Response:

```
{
  "hasCookies": true,
  "cookiesMasked": "_legacy_normandy_session= …",
  "cookiesFull": "_legacy_normandy_session=gwoidjaoidjwjdwojowajwd",
  "nextAlarmISO": null
}
```
