import { ReadStream } from "node:fs";
import type { OpenAI } from "openai";
import pino from "pino";
import { describe, expect, test } from "vitest";
import { OpenAISTT, type TranscriptionClient } from "./stt.js";

class RecordingTranscriptions implements TranscriptionClient {
  requests: OpenAI.Audio.TranscriptionCreateParamsNonStreaming[] = [];

  async create(request: OpenAI.Audio.TranscriptionCreateParamsNonStreaming) {
    this.requests.push(request);
    if (!(request.file instanceof ReadStream)) {
      throw new Error("Expected an audio file stream");
    }
    for await (const chunk of request.file) {
      void chunk;
    }
    return { text: "Привет" };
  }
}

describe("OpenAISTT", () => {
  test.each([
    { model: "gpt-transcribe", language: "auto,ru", message: 'Use "auto" alone' },
    { model: "gpt-transcribe", language: "ru,", message: 'Use "auto" alone' },
    {
      model: "whisper-1",
      language: "ru,en",
      message: "Multiple language hints require gpt-transcribe",
    },
    {
      model: "gpt-4o-transcribe",
      language: "ru,en",
      message: "Multiple language hints require gpt-transcribe",
    },
  ])(
    "rejects invalid language hints for $model / $language before requesting OpenAI",
    async ({ model, language, message }) => {
      const client = new RecordingTranscriptions();
      const logger = pino({ level: "silent" });
      const session = new OpenAISTT({ apiKey: "test", model }, logger, client).createSession({
        logger,
        language,
      });
      const failure = new Promise((_, reject) => session.on("error", reject));
      await session.connect();
      session.appendPcm16(Buffer.from([0, 0, 0, 0]));
      session.commit();
      await expect(failure).rejects.toThrow(message);
      expect(client.requests).toEqual([]);
      session.close();
    },
  );

  test.each([
    { model: "whisper-1", language: "auto", hint: {} },
    { model: "gpt-4o-transcribe", language: "auto", hint: {} },
    { model: "gpt-transcribe", language: "auto", hint: {} },
    { model: "gpt-transcribe", language: "ru", hint: { languages: ["ru"] } },
    { model: "gpt-4o-transcribe", language: "ru", hint: { language: "ru" } },
    { model: "whisper-1", language: undefined, hint: {} },
    { model: undefined, language: undefined, hint: {} },
    { model: undefined, language: "auto", hint: {} },
    { model: undefined, language: "ru", hint: { languages: ["ru"] } },
    { model: "gpt-transcribe", language: "ru,en", hint: { languages: ["ru", "en"] } },
    { model: undefined, language: " ru, en ", hint: { languages: ["ru", "en"] } },
  ])(
    "sends the correct language hint for $model / $language",
    async ({ model, language, hint }) => {
      const client = new RecordingTranscriptions();
      const logger = pino({ level: "silent" });
      const provider = new OpenAISTT({ apiKey: "test", model }, logger, client);
      const session = provider.createSession({
        logger,
        language,
        prompt: "Only transcribe the speaker.",
      });
      const transcript = new Promise<string>((resolve, reject) => {
        session.on("transcript", (event) => resolve(event.transcript));
        session.on("error", reject);
      });
      await session.connect();
      session.appendPcm16(Buffer.from([0, 0, 0, 0]));
      session.commit();
      await expect(transcript).resolves.toBe("Привет");
      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]).toEqual({
        file: expect.any(ReadStream),
        model: model ?? "gpt-transcribe",
        prompt: "Only transcribe the speaker.",
        response_format: "json",
        ...(model === "gpt-4o-transcribe" ? { include: ["logprobs"] } : {}),
        ...hint,
      });
      session.close();
    },
  );
});
