import type { DragEvent as ReactDragEvent } from 'react';

export interface DragPreviewHandle {
  move: (event: DragEvent | ReactDragEvent<HTMLElement>) => void;
  finish: (target?: HTMLElement | null) => void;
}

export function createDragPreview(event: ReactDragEvent<HTMLElement>): DragPreviewHandle {
  const source = event.currentTarget;
  const rect = source.getBoundingClientRect();
  const clone = source.cloneNode(true) as HTMLElement;
  const pointerOffsetX = event.clientX - rect.left;
  const pointerOffsetY = event.clientY - rect.top;
  let cleanedUp = false;

  clone.classList.add('drag-floating-preview');
  clone.removeAttribute('draggable');
  clone.style.position = 'fixed';
  clone.style.inset = '0 auto auto 0';
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  clone.style.margin = '0';
  clone.style.pointerEvents = 'none';
  clone.style.zIndex = '10000';
  clone.style.viewTransitionName = 'none';
  document.body.append(clone);

  hideNativeDragImage(event);

  const setPosition = (clientX: number, clientY: number) => {
    clone.style.transform = `translate3d(${clientX - pointerOffsetX}px, ${clientY - pointerOffsetY}px, 0)`;
  };

  setPosition(event.clientX, event.clientY);

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    clone.remove();
  };

  return {
    move(nextEvent) {
      if (cleanedUp || !hasUsableDragCoordinates(nextEvent)) {
        return;
      }

      setPosition(nextEvent.clientX, nextEvent.clientY);
    },
    finish(target) {
      if (cleanedUp) {
        return;
      }

      if (!target) {
        cleanup();
        return;
      }

      const targetRect = target.getBoundingClientRect();
      const animation = clone.animate([
        { transform: clone.style.transform, opacity: 0.96 },
        { transform: `translate3d(${targetRect.left}px, ${targetRect.top}px, 0)`, opacity: 0 },
      ], {
        duration: 150,
        easing: 'cubic-bezier(0.2, 0, 0.2, 1)',
        fill: 'forwards',
      });

      animation.addEventListener('finish', cleanup, { once: true });
      animation.addEventListener('cancel', cleanup, { once: true });
    },
  };
}

function hideNativeDragImage(event: ReactDragEvent<HTMLElement>): void {
  const preview = document.createElement('div');

  preview.style.position = 'fixed';
  preview.style.left = '-100px';
  preview.style.top = '-100px';
  preview.style.width = '1px';
  preview.style.height = '1px';
  preview.style.opacity = '0';
  preview.style.pointerEvents = 'none';
  document.body.append(preview);
  event.dataTransfer.setDragImage(preview, 0, 0);
  window.setTimeout(() => preview.remove(), 0);
}

function hasUsableDragCoordinates(event: DragEvent | ReactDragEvent<HTMLElement>): boolean {
  return event.clientX !== 0 || event.clientY !== 0;
}
