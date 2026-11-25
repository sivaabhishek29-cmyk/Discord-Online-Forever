var http = require("http");

var PORT = process.env.PORT || 8080;
var startedAt = Date.now();
var botStatus = { ready: false, vc: null, target: null };

function setStatus(patch) {
  Object.assign(botStatus, patch || {});
}

var server = http.createServer(function (req, res) {
  if (req.url === "/health" || req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        bot: botStatus,
      })
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.write("I'm alive");
  res.end();
});

server.on("error", function (err) {
  console.error("keep_alive server error:", err.message);
});

server.listen(PORT, "0.0.0.0", function () {
  console.log("keep_alive listening on port " + PORT);
});

module.exports = { setStatus: setStatus };
