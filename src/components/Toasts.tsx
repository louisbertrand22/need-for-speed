/* Toast list (UIState.toasts): the engine owns the lifetime, the UI animates enter / exit. */
import type { CSSProperties } from 'react';
import { CircleDollarSign, Flame, Info, LockOpen, MapPin, Siren, Tornado, TriangleExclamationPoint } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Toast, ToastKind } from '../core/types';
import { usePresenceList, useUI } from './hooks';
import { cx } from './kit';

const KIND: Record<ToastKind, { color: string; icon: LucideIcon }> = {
  info: { color: '#22e3ff', icon: Info },
  reward: { color: '#ffc233', icon: CircleDollarSign },
  warning: { color: '#ff7a1a', icon: TriangleExclamationPoint },
  police: { color: '#ff3344', icon: Siren },
  drift: { color: '#ff2d95', icon: Tornado },
  nitro: { color: '#3a8bff', icon: Flame },
  unlock: { color: '#b48cff', icon: LockOpen },
  district: { color: '#7dff6a', icon: MapPin },
};

const getKey = (t: Toast) => t.id;

export function Toasts({ align = 'right', max = 5 }: { align?: 'right' | 'center'; max?: number }) {
  const toasts = useUI((s) => s.toasts);
  const list = usePresenceList(toasts, getKey, 320).slice(-max);
  if (list.length === 0) return null;
  return (
    <div className={cx('flex flex-col gap-[0.4rem]', align === 'right' ? 'items-end' : 'items-center')}>
      {list.map(({ item, leaving }) => {
        const k = KIND[item.kind] ?? KIND.info;
        const Icon = k.icon;
        return (
          <div
            key={item.id}
            className={cx('ax-toast', item.kind === 'police' && 'is-police', leaving ? 'ax-out' : align === 'right' ? 'ax-in-right' : 'ax-in-up')}
            style={{ '--ac': k.color } as CSSProperties}
          >
            <span className="ax-toast-ico">
              <Icon className="h-[1.15rem] w-[1.15rem]" strokeWidth={2.4} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-display text-[0.78rem] font-bold uppercase italic tracking-[0.08em]" style={{ color: k.color }}>
                {item.title}
              </span>
              {item.text ? <span className="text-[0.92rem] font-semibold leading-tight text-white/90">{item.text}</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
