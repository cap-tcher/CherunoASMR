// 拖把手排序（ADV3.0 F-32／F-43）：只能從把手拖；把手也吃上下鍵（鍵盤可用）。放開的那列用底色提示。
import { useState, type DragEvent, type KeyboardEvent } from 'react';

export function useDragSort<T>(list: T[], setList: (l: T[]) => void) {
  const [from, setFrom] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const move = (i: number, j: number) => {
    if (i === j || j < 0 || j >= list.length) return;
    const next = [...list];
    const [x] = next.splice(i, 1);
    next.splice(j, 0, x!);
    setList(next);
  };
  return {
    handle: (i: number) => ({
      draggable: true,
      role: 'button',
      tabIndex: 0,
      'aria-label': '拖曳排序（也可以按上下鍵）',
      title: '拖曳排序（也可以按上下鍵）',
      onDragStart: (e: DragEvent) => {
        setFrom(i);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
      },
      onDragEnd: () => {
        setFrom(null);
        setOver(null);
      },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          move(i, e.key === 'ArrowUp' ? i - 1 : i + 1);
        }
      },
    }),
    row: (i: number) => ({
      onDragOver: (e: DragEvent) => {
        if (from === null) return;
        e.preventDefault();
        setOver(i);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        if (from !== null) move(from, i);
        setFrom(null);
        setOver(null);
      },
      'data-drop': over === i && from !== null && from !== i ? 'target' : undefined,
    }),
  };
}

export function Grip(props: ReturnType<ReturnType<typeof useDragSort>['handle']>) {
  return (
    <span className="grip" {...props}>
      <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true">
        {[3, 8, 13].map((y) => [3, 9].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.4" fill="currentColor" />))}
      </svg>
    </span>
  );
}
