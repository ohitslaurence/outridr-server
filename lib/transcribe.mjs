/**
 * POST /transcribe — proxy raw audio to Groq's Whisper transcription API.
 *
 * The client (outridr app) records a short clip and POSTs the raw audio bytes
 * with a Content-Type of the recording's mime. We forward it to Groq with the
 * key from config (~/.config/outridr/config.json → groq.apiKey), so the key
 * lives once on this machine and never on any device. Returns { text }.
 *
 * Zero-dep: Node's global fetch/FormData/Blob (Node >= 18) do the multipart.
 */
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Groq's per-request limit.

function filenameFor(contentType) {
  const type = contentType.toLowerCase();
  if (type.includes("wav")) return "audio.wav";
  if (type.includes("webm")) return "audio.webm";
  if (type.includes("ogg")) return "audio.ogg";
  if (type.includes("mp3") || type.includes("mpeg") || type.includes("mpga")) return "audio.mp3";
  // iOS expo-audio records m4a (audio/mp4 / audio/x-m4a).
  return "audio.m4a";
}

export function serveTranscribe(config, req, res) {
  const chunks = [];
  let total = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    total += chunk.length;
    if (total > MAX_AUDIO_BYTES) {
      aborted = true;
      res.writeHead(413).end("audio too large");
      req.destroy();
    } else {
      chunks.push(chunk);
    }
  });

  req.on("error", () => {
    if (!aborted) {
      aborted = true;
      res.destroy();
    }
  });

  req.on("end", async () => {
    if (aborted) {
      return;
    }
    const audio = Buffer.concat(chunks);
    if (audio.length === 0) {
      res.writeHead(400).end("empty audio");
      return;
    }
    try {
      const contentType = req.headers["content-type"] || "audio/m4a";
      const form = new FormData();
      form.append("file", new Blob([audio], { type: contentType }), filenameFor(contentType));
      form.append("model", config.groq.model);
      form.append("response_format", "json");

      const groqRes = await fetch(GROQ_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${config.groq.apiKey}` },
        body: form,
      });

      if (!groqRes.ok) {
        const detail = (await groqRes.text()).slice(0, 300);
        console.error(`outridr: groq transcription failed ${groqRes.status}: ${detail}`);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "transcription failed", status: groqRes.status }));
        return;
      }

      const data = await groqRes.json();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: typeof data.text === "string" ? data.text.trim() : "" }));
    } catch (error) {
      console.error(`outridr: transcription error: ${error.message}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "transcription error" }));
    }
  });
}
