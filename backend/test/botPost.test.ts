import { describe, it, expect, vi } from 'vitest';
import { PostError, buildPostMessage, postToChannel, type PostPayload } from '../src/bot/post';

const payload = (over: Partial<PostPayload> = {}): PostPayload => ({
  channelId: 'chan-1',
  content: 'New launch: TRENCH',
  ...over,
});

describe('buildPostMessage', () => {
  it('passes trimmed content through', () => {
    expect(buildPostMessage(payload({ content: '  hello  ' }))).toEqual({ content: 'hello' });
  });

  it('wraps a single embed into an embeds array', () => {
    const embed = { title: 'Launch', description: 'mint…' };
    expect(buildPostMessage(payload({ content: undefined, embed }))).toEqual({ embeds: [embed] });
  });

  it('sends content and embed together when both are given', () => {
    const embed = { title: 'Launch' };
    expect(buildPostMessage(payload({ embed }))).toEqual({
      content: 'New launch: TRENCH',
      embeds: [embed],
    });
  });

  it('rejects a message with neither content nor embed', () => {
    expect(() => buildPostMessage(payload({ content: undefined }))).toThrowError(PostError);
    expect(() => buildPostMessage(payload({ content: '   ' }))).toThrowError(PostError);
  });

  it('rejects a non-object embed', () => {
    expect(() => buildPostMessage(payload({ embed: [1, 2] as any }))).toThrowError(PostError);
  });

  it('rejects content over the Discord 2000-char cap', () => {
    expect(() => buildPostMessage(payload({ content: 'x'.repeat(2001) }))).toThrowError(PostError);
  });
});

describe('postToChannel', () => {
  it('throws bot_disabled when there is no client', async () => {
    await expect(postToChannel(null, payload())).rejects.toMatchObject({ code: 'bot_disabled' });
  });

  it('validates the payload before touching the client', async () => {
    await expect(postToChannel(null, payload({ content: undefined }))).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('posts to the requested channel and returns channel + message ids', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'msg-9' });
    const fakeClient: any = { channels: { fetch: vi.fn().mockResolvedValue({ send }) } };

    const result = await postToChannel(fakeClient, payload());

    expect(result).toEqual({ channelId: 'chan-1', messageId: 'msg-9' });
    expect(fakeClient.channels.fetch).toHaveBeenCalledWith('chan-1');
    expect(send).toHaveBeenCalledWith({ content: 'New launch: TRENCH' });
  });

  it('maps Unknown Channel (10003) to channel_unknown', async () => {
    const fakeClient: any = { channels: { fetch: vi.fn().mockRejectedValue({ code: 10003 }) } };
    await expect(postToChannel(fakeClient, payload())).rejects.toMatchObject({
      code: 'channel_unknown',
    });
  });

  it('treats a non-postable channel as channel_unknown', async () => {
    const fakeClient: any = { channels: { fetch: vi.fn().mockResolvedValue({ isVoiceBased: () => true }) } };
    await expect(postToChannel(fakeClient, payload())).rejects.toMatchObject({
      code: 'channel_unknown',
    });
  });

  it('maps a Discord permission error on fetch to forbidden', async () => {
    const fakeClient: any = { channels: { fetch: vi.fn().mockRejectedValue({ code: 50001 }) } };
    await expect(postToChannel(fakeClient, payload())).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('maps a Discord permission error on send to forbidden', async () => {
    const send = vi.fn().mockRejectedValue({ code: 50013 });
    const fakeClient: any = { channels: { fetch: vi.fn().mockResolvedValue({ send }) } };
    await expect(postToChannel(fakeClient, payload())).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('maps any other send failure to send_failed', async () => {
    const send = vi.fn().mockRejectedValue(new Error('network'));
    const fakeClient: any = { channels: { fetch: vi.fn().mockResolvedValue({ send }) } };
    await expect(postToChannel(fakeClient, payload())).rejects.toMatchObject({ code: 'send_failed' });
  });

  it('PostError carries its code as a property', () => {
    const err = new PostError('channel_unknown', 'nope');
    expect(err.code).toBe('channel_unknown');
    expect(err).toBeInstanceOf(Error);
  });
});
