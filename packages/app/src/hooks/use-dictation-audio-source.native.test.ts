/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AudioEngineCallbacks } from "@/audio";

// Keep-awake and the audio engine are native modules. These fakes keep the
// same state the native side keeps: a set of active keep-awake tags.
const keepAwakeTags = vi.hoisted(() => new Set<string>());
const engine = vi.hoisted(() => ({ callbacks: null as AudioEngineCallbacks | null }));

vi.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: async (tag: string) => {
    keepAwakeTags.add(tag);
  },
  deactivateKeepAwake: async (tag: string) => {
    keepAwakeTags.delete(tag);
  },
}));
vi.mock("@/audio", () => ({
  createAudioEngine: (callbacks: AudioEngineCallbacks) => {
    engine.callbacks = callbacks;
    return {
      initialize: async () => {},
      startCapture: async () => {},
      stopCapture: async () => {},
      destroy: async () => {},
    };
  },
}));

import { useDictationAudioSource } from "./use-dictation-audio-source.native";

beforeEach(() => {
  keepAwakeTags.clear();
  engine.callbacks = null;
});

function renderAudioSource(onInterruption = vi.fn()) {
  return renderHook(() => useDictationAudioSource({ onPcmSegment: () => {}, onInterruption }));
}

it("keeps the screen on while recording", async () => {
  const { result } = renderAudioSource();

  await act(() => result.current.start());
  expect(keepAwakeTags.size).toBe(1);

  await act(() => result.current.stop());
  expect(keepAwakeTags.size).toBe(0);
});

it("lets the screen turn off when another audio source interrupts recording", async () => {
  const onInterruption = vi.fn();
  const { result } = renderAudioSource(onInterruption);

  await act(() => result.current.start());
  expect(keepAwakeTags.size).toBe(1);
  act(() => engine.callbacks?.onInterruption?.());

  expect(onInterruption).toHaveBeenCalledOnce();
  expect(keepAwakeTags.size).toBe(0);
});

it("lets the screen turn off when unmounted while recording", async () => {
  const { result, unmount } = renderAudioSource();

  await act(() => result.current.start());
  expect(keepAwakeTags.size).toBe(1);
  unmount();

  expect(keepAwakeTags.size).toBe(0);
});
