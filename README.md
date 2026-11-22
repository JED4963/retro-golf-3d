# Retro Golf 3D

A 3D golf game that plays in the browser, plus the small server that runs its online matches.

- `index.html` is the whole game in one file. It also plays on its own, with no internet, if you just open it.
- `server.js` hands out that page and runs the online rooms: 2 to 4 players play the same holes at the same time and
  see each other on the course. It needs Node.js and nothing else (no installs).

The server keeps nothing on disk. All it ever sees is the golfer name a player typed (capital letters and numbers,
12 long at most) and how their golfer looks. There is no chat.

## Run it

```
node server.js
```

Then open `http://localhost:8791/`, press PLAY ONLINE, and CREATE ROOM (or QUICK MATCH). Other players press
JOIN WITH CODE and type the 4 letters.

On a hosting service the start command is `node server.js`; the server reads the port from `PORT`.
