import type { Request, Response } from 'express';
import { newId } from '../lib/ids.js';
import type { DonationOptions, DonationRow, Donations } from './donations.js';
import { spokenText } from './moderation.js';
import { hindiSpeech } from './speech.js';

export interface Alert {
  id: string;
  donor_name: string;
  amount: number;
  currency: string;
  message: string;
  /** What the voice page reads; null when this alert isn't read aloud. */
  spoken: string | null;
  /** The same, rewritten for a Hindi voice when the message is Hindi or Hinglish; otherwise null. */
  spoken_hindi: string | null;
  /** What the streamer calls a donation, for the voice's "Rahul sent a Flare." */
  donation_name: string;
  test: boolean;
}

/**
 * Plays each streamer's alerts one at a time and pushes them to every page that streamer has open
 * (the OBS overlay and the voice tab) with Server-Sent Events. The server keeps the clock,
 * so all of those pages stay in step, and a page that reloads picks up the alert that's showing.
 */
export class AlertHub {
  private readonly clients = new Map<string, Set<Response>>();
  private readonly playing = new Map<string, { alert: Alert; endsAt: number; timer: NodeJS.Timeout }>();
  private readonly tests = new Map<string, Alert[]>();
  private readonly gapMs: number;
  private readonly timeScale: number;

  constructor(private readonly donations: Donations, options: DonationOptions) {
    this.gapMs = options.alertGapMs ?? 1500;
    this.timeScale = options.timeScale ?? 1;
  }

  subscribe(streamerId: string, req: Request, res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // tell proxies such as nginx not to hold events back
    });
    res.write('retry: 3000\n\n');
    // The voice tab's test lines use the streamer's own name for a donation.
    this.write(res, { type: 'hello', donation_name: this.donations.profileOf(streamerId)?.donation_name ?? 'Flare' });
    let set = this.clients.get(streamerId);
    if (!set) this.clients.set(streamerId, (set = new Set()));
    set.add(res);
    const playing = this.playing.get(streamerId);
    if (playing) this.write(res, { type: 'alert', alert: playing.alert, duration_ms: Math.max(0, playing.endsAt - Date.now()) });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    heartbeat.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      set.delete(res);
    });
    this.poke(streamerId);
  }

  clientCount(streamerId: string): number {
    return this.clients.get(streamerId)?.size ?? 0;
  }

  nowShowing(streamerId: string): Alert | null {
    return this.playing.get(streamerId)?.alert ?? null;
  }

  disconnectAll(streamerId: string): void {
    for (const res of this.clients.get(streamerId) ?? []) res.end();
    this.clients.delete(streamerId);
  }

  /** Something may be waiting: play it if nothing is showing, alerts aren't paused, and an overlay is open. */
  poke(streamerId: string): void {
    if (this.playing.has(streamerId) || this.clientCount(streamerId) === 0) return;
    const profile = this.donations.profileOf(streamerId);
    if (!profile || profile.alerts_paused) return;
    const alert = this.tests.get(streamerId)?.shift() ?? this.toAlert(this.donations.takeNextAlert(streamerId));
    if (!alert) return;
    const durationMs = this.durationMs(alert, profile.alert_seconds);
    const timer = setTimeout(() => this.finish(streamerId), durationMs);
    timer.unref();
    this.playing.set(streamerId, { alert, endsAt: Date.now() + durationMs, timer });
    this.broadcast(streamerId, { type: 'alert', alert, duration_ms: durationMs });
  }

  skip(streamerId: string): void {
    const playing = this.playing.get(streamerId);
    if (!playing) return;
    clearTimeout(playing.timer);
    this.finish(streamerId);
  }

  /** A sample alert for checking the OBS setup. It is never stored. */
  test(streamerId: string, tts: boolean): void {
    const queue = this.tests.get(streamerId) ?? [];
    const donationName = this.donations.profileOf(streamerId)?.donation_name ?? 'Flare';
    queue.push({
      id: newId('test'), donor_name: 'Test donor', amount: 10000, currency: 'inr',
      message: 'This is a test alert. If you can read and hear this, your overlay works!',
      spoken: tts ? 'This is a test alert. If you can read and hear this, your overlay works!' : null,
      spoken_hindi: null,
      donation_name: donationName,
      test: true,
    });
    this.tests.set(streamerId, queue);
    this.poke(streamerId);
  }

  stop(): void {
    for (const { timer } of this.playing.values()) clearTimeout(timer);
    this.playing.clear();
    for (const set of this.clients.values()) for (const res of set) res.end();
    this.clients.clear();
  }

  private finish(streamerId: string): void {
    this.playing.delete(streamerId);
    this.broadcast(streamerId, { type: 'clear' });
    setTimeout(() => this.poke(streamerId), this.gapMs * this.timeScale).unref();
  }

  private toAlert(d: DonationRow | undefined): Alert | undefined {
    if (!d) return undefined;
    const spoken = d.tts ? spokenText(d.message) : null;
    return {
      id: d.id, donor_name: d.donor_name, amount: d.amount, currency: d.currency, message: d.message,
      spoken, spoken_hindi: spoken && hindiSpeech(spoken),
      donation_name: this.donations.profileOf(d.streamer_id)?.donation_name ?? 'Flare', test: false,
    };
  }

  /** Long enough to read the message, and to say it when it's read aloud (~14 characters a second). */
  private durationMs(alert: Alert, minSeconds: number): number {
    const reading = 3000 + alert.message.length * 45;
    const speaking = alert.spoken ? 3500 + alert.spoken.length * 75 : 0;
    return Math.round(Math.min(30_000, Math.max(minSeconds * 1000, reading, speaking)) * this.timeScale);
  }

  private broadcast(streamerId: string, event: object): void {
    for (const res of this.clients.get(streamerId) ?? []) this.write(res, event);
  }

  private write(res: Response, event: object): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
