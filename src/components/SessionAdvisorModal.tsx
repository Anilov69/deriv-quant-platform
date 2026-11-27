import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

export type SessionAdvisorMode = 'TP_HIT' | 'SL_PARTIAL_WINS' | 'SL_ZERO_WINS';

export interface SessionAdvisorState {
  mode: SessionAdvisorMode;
  pnl: number;
  wins: number;
  losses: number;
  peakLevel: number;
  stopLoss: number;
  takeProfit: number;
  /** Set when the pre-trade headroom guard blocked the next bundle. */
  nextBundleCost?: number;
}

interface Props {
  open: boolean;
  state: SessionAdvisorState | null;
  currency: string;
  onDismiss: () => void;
  onReset: () => void;
  /** Optional copy variant. The mesh page keeps the original wording by default. */
  variant?: 'mesh' | 'straddle' | 'paroli' | 'collar';
}

interface AdvisorConfig {
  durationSec: number;
  badge: string;
  action: string;
  message: string;
  bullets: string[];
  shell: string;
  badgeTone: string;
  accent: string;
  primary: string;
}

const CONFIG: Record<SessionAdvisorMode, AdvisorConfig> = {
  TP_HIT: {
    durationSec: 300,
    badge: 'TAKE PROFIT HIT',
    action: 'Stop Trading for 5 Minutes',
    message:
      'You captured a clean positive variance run and hit your Take Profit target. Because Deriv\'s RNG has zero memory, staying in immediately exposes your banked profit to a random cold streak. Step away for 5 minutes, let the market cycle, and consider securing your profit before starting a fresh session at your base stake.',
    bullets: [
      'Keep your next session at your base stake—never double up just because you won.',
      'Review your Round History or export your CSV log while the 5-minute timer cools down.',
    ],
    shell: 'border-accent/60',
    badgeTone: 'bg-accent text-ink',
    accent: 'text-accent',
    primary: 'bg-accent text-ink hover:bg-accent/90',
  },
  SL_PARTIAL_WINS: {
    durationSec: 600,
    badge: 'STOP LOSS — PARTIAL WINS',
    action: 'Pause Trading for 10 Minutes',
    message:
      "Your 1-cycle Stop Loss did its exact job—it cut off a cold streak before it could bleed into a second Martingale cycle. Even after earlier wins, a 3- or 4-round miss is normal statistical variance on a random generator. Step away for 10 minutes so you don't revenge-trade.",
    bullets: [
      'Do not increase your base stake or Max Levels to try to win it back faster.',
      'Confirm your remaining wallet still holds at least 3× your 1-cycle Stop Loss before resuming.',
    ],
    shell: 'border-amber-400/60',
    badgeTone: 'bg-amber-400 text-ink',
    accent: 'text-amber-300',
    primary: 'bg-amber-400 text-ink hover:bg-amber-300',
  },
  SL_ZERO_WINS: {
    durationSec: 900,
    badge: 'STOP LOSS — ZERO WINS',
    action: 'Step Away for 15 Minutes (or Switch to Demo)',
    message:
      "You ran straight into an immediate cold cluster from Level 0 through your Martingale cap without a single hit. On a 3-digit hedge, losing 3 to 4 rounds in a row happens ~24%–34% of the time purely by chance—it does not mean the bot is broken, and it does not mean a win is 'due' next tick. Take a 15-minute break to clear any frustration before placing another trade.",
    bullets: [
      'Never immediately restart at a higher stake after a 0-win stop-out—that is the #1 cause of blown accounts.',
      'After the 15-minute cooldown, check that your symbol is a fast 1s index (1HZ100V / 1HZ75V), verify dominance is at least 36%–40%, and run 3 test rounds on Demo if you want to verify flow before going back to Real.',
    ],
    shell: 'border-danger/60',
    badgeTone: 'bg-danger text-ink',
    accent: 'text-danger',
    primary: 'bg-danger text-ink hover:bg-danger/90',
  },
};

const STRADDLE_CONFIG: Record<SessionAdvisorMode, AdvisorConfig> = {
  TP_HIT: {
    durationSec: 300,
    badge: 'TAKE PROFIT HIT',
    action: 'Stop Trading for 5 Minutes',
    message:
      'Your dual one-touch straddle banked a positive variance run and hit Take Profit. A straddle is two independent touch bets: one leg paying does not make the next corridor more likely to touch. Step away for 5 minutes, then restart at the base leg stake rather than trying to force another whipsaw.',
    bullets: [
      'Do not widen the barriers or raise the leg stake just because the last round won.',
      'Review the grouped straddle history or export the CSV while the 5-minute timer cools down.',
    ],
    shell: 'border-accent/60',
    badgeTone: 'bg-accent text-ink',
    accent: 'text-accent',
    primary: 'bg-accent text-ink hover:bg-accent/90',
  },
  SL_PARTIAL_WINS: {
    durationSec: 600,
    badge: 'STOP LOSS — PARTIAL WINS',
    action: 'Pause Trading for 10 Minutes',
    message:
      "Your straddle Stop Loss cut off a quiet-range or one-sided bleed before it could consume another Martingale cycle. Even after earlier touches, long stretches where neither barrier is reached are normal on a random walk. Pause for 10 minutes instead of revenge-firing a wider corridor.",
    bullets: [
      'Do not raise the base stake, Max Levels, or barrier width to win it back faster.',
      'Confirm your remaining wallet still holds at least 3× the 1-cycle straddle Stop Loss before resuming.',
    ],
    shell: 'border-amber-400/60',
    badgeTone: 'bg-amber-400 text-ink',
    accent: 'text-amber-300',
    primary: 'bg-amber-400 text-ink hover:bg-amber-300',
  },
  SL_ZERO_WINS: {
    durationSec: 900,
    badge: 'STOP LOSS — ZERO WINS',
    action: 'Step Away for 15 Minutes (or Switch to Demo)',
    message:
      "You ran from Level 0 through your Martingale cap without a single winning leg. A straddle can lose every round when the market stays inside both barriers; that is variance, not a broken signal. Take a 15-minute break before placing another trade.",
    bullets: [
      'Never restart at a higher stake or tighter barrier after a 0-win stop-out.',
      'After the cooldown, verify contracts_for still offers ONETOUCH in a supported duration and run a few Demo rounds before returning to Real.',
    ],
    shell: 'border-danger/60',
    badgeTone: 'bg-danger text-ink',
    accent: 'text-danger',
    primary: 'bg-danger text-ink hover:bg-danger/90',
  },
};

const PAROLI_CONFIG: Record<SessionAdvisorMode, AdvisorConfig> = {
  TP_HIT: {
    durationSec: 300,
    badge: 'TAKE PROFIT HIT',
    action: 'Stop Trading for 5 Minutes',
    message:
      'Your Paroli burst ladder reached Take Profit. The last roll was paid by house money, but each new burst still starts at the base stake and each 1-tick digit contract is independent. Step away for 5 minutes, then restart at the base stake instead of trying to compound the win.',
    bullets: [
      'Keep the next burst at the same base stake and reinvestment percentage.',
      'Review the grouped burst history or export the CSV while the 5-minute timer cools down.',
    ],
    shell: 'border-accent/60',
    badgeTone: 'bg-accent text-ink',
    accent: 'text-accent',
    primary: 'bg-accent text-ink hover:bg-accent/90',
  },
  SL_PARTIAL_WINS: {
    durationSec: 600,
    badge: 'STOP LOSS — PARTIAL WINS',
    action: 'Pause Trading for 10 Minutes',
    message:
      'Your Paroli Stop Loss cut off a cold stretch after at least one winning first step. A later losing step at 100% reinvestment only gives back the base stake; the earlier win was already banked. Long droughts are normal on a random feed, so pause for 10 minutes instead of chasing the next trigger.',
    bullets: [
      'Do not raise the base stake, add a fourth step, or lower the drought threshold to win it back faster.',
      'Confirm the remaining wallet still holds at least 3× the one-burst Stop Loss before resuming.',
    ],
    shell: 'border-amber-400/60',
    badgeTone: 'bg-amber-400 text-ink',
    accent: 'text-amber-300',
    primary: 'bg-amber-400 text-ink hover:bg-amber-300',
  },
  SL_ZERO_WINS: {
    durationSec: 900,
    badge: 'STOP LOSS — ZERO WINS',
    action: 'Step Away for 15 Minutes (or Switch to Demo)',
    message:
      'Every settled burst missed its first step, so the Paroli ladder never reached house-money. A 3-of-10 digit tail misses seven times out of ten; several first-step misses in a row are ordinary variance, not a broken radar. Take a 15-minute break before placing another trade.',
    bullets: [
      'Never restart at a higher base stake, a deeper step count, or a lower threshold after a zero-win stop-out.',
      'After the cooldown, verify the 1HZ feeds are still streaming and run a few Demo bursts before returning to Real.',
    ],
    shell: 'border-danger/60',
    badgeTone: 'bg-danger text-ink',
    accent: 'text-danger',
    primary: 'bg-danger text-ink hover:bg-danger/90',
  },
};

const COLLAR_CONFIG: Record<SessionAdvisorMode, AdvisorConfig> = {
  TP_HIT: {
    durationSec: 300,
    badge: 'TAKE PROFIT HIT',
    action: 'Stop Trading for 5 Minutes',
    message:
      'Your contingent collar reached its Take Profit target. The round is settled; a corridor double-win pays only because the move stayed between the first leg\'s entry and the opposite leg\'s lock. The next impulse is independent, so step away for 5 minutes and restart at the flat preset stake.',
    bullets: [
      'Keep the next collar at the symmetric preset and let the window close with no Leg 2 rather than forcing a lock.',
      'Review the grouped round log or export the CSV while the 5-minute timer cools down.',
    ],
    shell: 'border-accent/60',
    badgeTone: 'bg-accent text-ink',
    accent: 'text-accent',
    primary: 'bg-accent text-ink hover:bg-accent/90',
  },
  SL_PARTIAL_WINS: {
    durationSec: 600,
    badge: 'STOP LOSS — PARTIAL WINS',
    action: 'Pause Trading for 10 Minutes',
    message:
      'Your collateral stop was hit after at least one winning collar. Locked one-leg breakouts and full reversals are the normal cost of protecting the corridor; they are not a reason to widen the corridor or raise both stakes. Pause for 10 minutes before the next impulse.',
    bullets: [
      'Do not lower the impulse threshold or enlarge the corridor ATR multiple to force more locks.',
      'Confirm the wallet still holds at least 3× the complete collar stop before resuming.',
    ],
    shell: 'border-amber-400/60',
    badgeTone: 'bg-amber-400 text-ink',
    accent: 'text-amber-300',
    primary: 'bg-amber-400 text-ink hover:bg-amber-300',
  },
  SL_ZERO_WINS: {
    durationSec: 900,
    badge: 'STOP LOSS — ZERO WINS',
    action: 'Step Away for 15 Minutes (or Switch to Demo)',
    message:
      'No settled collar has produced a positive net round yet. A one-tick binary move is random even when the impulse filter is aligned; consecutive saved misses and scratches are ordinary variance, not a broken engine. Take a 15-minute break before arming again.',
    bullets: [
      'Never chase the stop by increasing either leg, adding a third leg, or disabling the impulse filter.',
      'After the cooldown, confirm the tick feed is live and run several Demo collars before returning to Real.',
    ],
    shell: 'border-danger/60',
    badgeTone: 'bg-danger text-ink',
    accent: 'text-danger',
    primary: 'bg-danger text-ink hover:bg-danger/90',
  },
};

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}

function Money({ value, currency }: { value: number; currency: string }): ReactElement {
  return <>{value.toFixed(2)} {currency}</>;
}

function Stat({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className='rounded border border-line bg-ink/60 px-3 py-2'>
      <dt className='text-[9px] uppercase tracking-widest text-muted'>{label}</dt>
      <dd className='mt-0.5 font-mono text-sm text-slate-100'>{children}</dd>
    </div>
  );
}

export default function SessionAdvisorModal({
  open,
  state,
  currency,
  onDismiss,
  onReset,
  variant = 'mesh',
}: Props): ReactElement | null {
  const configForMode = variant === 'straddle' ? STRADDLE_CONFIG : variant === 'paroli' ? PAROLI_CONFIG : variant === 'collar' ? COLLAR_CONFIG : CONFIG;
  const duration = state ? configForMode[state.mode].durationSec : 0;
  const [left, setLeft] = useState(duration);
  const deadlineRef = useRef(0);

  useEffect(() => {
    if (!open || !state) return;
    const total = configForMode[state.mode].durationSec;
    setLeft(total);
    deadlineRef.current = Date.now() + total * 1000;
    let intervalId = 0;
    const tick = () => {
      const next = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
      setLeft(next);
      if (next === 0) window.clearInterval(intervalId);
    };
    intervalId = window.setInterval(tick, 250);
    tick();
    return () => window.clearInterval(intervalId);
  }, [configForMode, open, state?.mode]);

  if (!open || !state) return null;
  const config = configForMode[state.mode];
  const locked = left > 0;
  const signed = (state.pnl >= 0 ? '+' : '-') + '$' + Math.abs(state.pnl).toFixed(2);
  const headline =
    state.mode === 'TP_HIT'
      ? 'Target Locked! ' + signed + ' Banked'
      : state.mode === 'SL_PARTIAL_WINS'
        ? 'Stop Loss Triggered (' + signed + ') — Capital Protected'
        : 'Cold-Start Stop Loss (' + signed + ' · 0 Wins) — Hard Pause';

  return (
    <div className='fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-3 sm:p-5' role='presentation'>
      <div
        role='dialog'
        aria-modal='true'
        aria-labelledby='advisor-headline'
        className={'max-h-[92vh] w-full max-w-2xl overflow-y-auto overscroll-contain rounded-lg border bg-panel p-4 shadow-2xl sm:p-5 ' + config.shell}
      >
        <div className='flex items-start justify-between gap-3'>
          <div>
            <span className={'inline-flex rounded-full px-2.5 py-1 text-[9px] font-bold uppercase tracking-widest ' + config.badgeTone}>
              {config.badge}
            </span>
            <h2 id='advisor-headline' className={'mt-2 text-xl font-semibold tracking-tight ' + config.accent}>
              {headline}
            </h2>
          </div>
          <button
            type='button'
            onClick={onDismiss}
            aria-label='Dismiss session advisor'
            className='rounded border border-line px-2 py-1 text-xs text-muted hover:text-slate-100'
          >
            Close
          </button>
        </div>

        <dl className='mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4'>
          <Stat label='Final session P/L'>
            <span className={state.pnl >= 0 ? 'text-accent' : 'text-danger'}>
              {state.pnl >= 0 ? '+' : '-'}<Money value={Math.abs(state.pnl)} currency={currency} />
            </span>
          </Stat>
          <Stat label={variant === 'paroli' ? 'Bursts settled' : variant === 'collar' ? 'Collars settled' : 'Rounds played'}>
            {state.wins + state.losses} <span className='text-[10px] text-muted'>({state.wins} W / {state.losses} L)</span>
          </Stat>
          <Stat label={variant === 'paroli' ? 'Peak Paroli step' : variant === 'collar' ? 'Peak collar level' : 'Peak martingale'}>L{state.peakLevel}</Stat>
          <Stat label='Session limits'>
            <span className='text-[10px]'>SL {state.stopLoss.toFixed(2)} / TP {state.takeProfit.toFixed(2)}</span>
          </Stat>
        </dl>

        {state.nextBundleCost !== undefined ? (
          <p className='mt-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger'>
            Headroom guard: no order was sent. The next {variant === 'straddle' ? 'straddle' : variant === 'paroli' ? 'burst' : variant === 'collar' ? 'collar' : 'bundle'} was <Money value={state.nextBundleCost} currency={currency} />. Losing it would breach your active Stop Loss, so the bot stopped before risking more capital.
          </p>
        ) : null}

        <div className={'mt-4 rounded border border-line bg-ink/50 p-3 ' + config.shell}>
          <div className='flex flex-wrap items-end justify-between gap-3'>
            <div>
              <p className='text-[9px] uppercase tracking-widest text-muted'>Discipline cooldown</p>
              <p className='font-mono text-3xl text-slate-100' aria-live='polite'>{formatClock(left)}</p>
            </div>
            <p className={'max-w-[260px] text-right text-[11px] font-semibold leading-snug ' + config.accent}>
              Recommended action: {config.action}
            </p>
          </div>
          <p className='mt-2 text-[10px] leading-relaxed text-muted'>
            The timer starts as soon as the modal opens. Dismissing it keeps the engine stopped and lets you review the {variant === 'straddle' ? 'barrier channel' : variant === 'paroli' ? 'radar pool' : variant === 'collar' ? 'collar corridor' : 'mesh'} and history without arming another trade.
          </p>
        </div>

        <blockquote className='mt-4 border-l-2 border-line pl-3 text-[11px] leading-relaxed text-slate-300'>
          <p className='mb-1 text-[9px] uppercase tracking-widest text-muted'>Advisor message</p>
          {config.message}
        </blockquote>

        <div className='mt-4'>
          <p className='text-[9px] uppercase tracking-widest text-muted'>Checklist</p>
          <ul className='mt-1 space-y-1.5 text-[11px] leading-relaxed text-slate-300'>
            {config.bullets.map((bullet) => (
              <li key={bullet} className='flex gap-2'>
                <span className={'mt-0.5 ' + config.accent}>•</span>
                <span>{bullet}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className='sticky bottom-0 -mx-4 mt-5 border-t border-line bg-panel px-4 pb-1 pt-3 shadow-[0_-10px_24px_rgba(0,0,0,0.35)] sm:-mx-5 sm:px-5'>
          <div className='flex flex-col-reverse gap-2 sm:flex-row sm:justify-end'>
            <button
              type='button'
              onClick={onDismiss}
              className='rounded border border-line px-3 py-2 text-xs font-medium text-muted hover:text-slate-100'
            >
              Dismiss & Review Charts
            </button>
            <button
              type='button'
              onClick={onReset}
              disabled={locked}
              className={'rounded px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ' + config.primary}
            >
              {locked ? 'Cooldown Active (' + formatClock(left) + ') — Wait Before Resuming' : 'Reset Session & Start Fresh'}
            </button>
          </div>
          <p className='mt-2 text-right text-[9px] text-muted'>
            Review the session before resuming. This modal does not place orders.
          </p>
        </div>
      </div>
    </div>
  );
}
