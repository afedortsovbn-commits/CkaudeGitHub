/**
 * JsSIP отправляет INVITE / 200 OK только после полного сбора ICE-кандидатов. Если у машины есть сетевой интерфейс,
 * с которого TURN не отвечает (виртуальная сеть WSL/Hyper-V, отключённый VPN), браузер ждёт таймаут STUN ≈ 40 с —
 * звонок уходит с задержкой, а ответ оператора не успевает до отмены по таймауту звонка. Звук всё равно идёт через
 * TURN, поэтому отправляем SDP, как только появился relay-кандидат, а без него — через 3 с после первого кандидата.
 * Обработчик живёт всю сессию: после ready() JsSIP снимает свой слушатель, и следующий кандидат — уже новый сбор
 * (re-INVITE, ICE restart).
 */
export function fastIceReady(fallbackMs = 3000): (e: { candidate: RTCIceCandidate; ready(): void }) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (e) => {
    const go = () => {
      clearTimeout(timer);
      timer = undefined;
      e.ready();
    };
    if (/\btyp relay\b/.test(e.candidate.candidate)) go();
    else if (!timer) timer = setTimeout(go, fallbackMs);
  };
}
