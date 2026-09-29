// Генератор сценария SIPp «клиент в IVR» (Ф6): INVITE → ACK → последовательность пауз и нажатий DTMF
// (SIP INFO application/dtmf-relay — Asterisk принимает его независимо от dtmf_mode) → пауза → BYE.
// Отбой со стороны КЦ до конца сценария — провал вызова (обрыв).
const head = (method, cseq, extra = '') => `
      ${method} [next_url] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: "SIPp [call_number]" <sip:[field0]@[local_ip]:[local_port]>;tag=[pid]SIPpTag00[call_number]
      To: <sip:[service]@[remote_ip]:[remote_port]>[peer_tag_param]
      Call-ID: [call_id]
      CSeq: ${cseq} ${method}
      [routes]
      Contact: <sip:sipp@[local_ip]:[local_port]>
      Max-Forwards: 70${extra}`;

/** steps: [[паузаМс, цифра], …]; tailMs — пауза перед отбоем. Номер клиента — из файла -inf (field0). */
export function ivrScenario(steps, tailMs) {
  let cseq = 2;
  const dtmf = steps
    .map(
      ([ms, d]) => `
  <pause milliseconds="${ms}"/>
  <send retrans="500"><![CDATA[${head('INFO', cseq++, '\n      Content-Type: application/dtmf-relay\n      Content-Length: [len]')}

Signal=${d}
Duration=160
]]></send>
  <recv response="200"/>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE scenario SYSTEM "sipp.dtd">
<scenario name="cc-uac-ivr">
  <send retrans="500"><![CDATA[
      INVITE sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: "SIPp [call_number]" <sip:[field0]@[local_ip]:[local_port]>;tag=[pid]SIPpTag00[call_number]
      To: <sip:[service]@[remote_ip]:[remote_port]>
      Call-ID: [call_id]
      CSeq: 1 INVITE
      Contact: <sip:sipp@[local_ip]:[local_port]>
      Max-Forwards: 70
      Content-Type: application/sdp
      Content-Length: [len]

v=0
o=user1 53655765 2353687637 IN IP[local_ip_type] [local_ip]
s=-
c=IN IP[media_ip_type] [media_ip]
t=0 0
m=audio [media_port] RTP/AVP 8 0 101
a=rtpmap:8 PCMA/8000
a=rtpmap:0 PCMU/8000
a=rtpmap:101 telephone-event/8000
a=sendrecv
]]></send>
  <recv response="100" optional="true"/>
  <recv response="180" optional="true"/>
  <recv response="183" optional="true"/>
  <recv response="200" rtd="true" rrs="true"/>
  <send><![CDATA[
      ACK [next_url] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: "SIPp [call_number]" <sip:[field0]@[local_ip]:[local_port]>;tag=[pid]SIPpTag00[call_number]
      To: <sip:[service]@[remote_ip]:[remote_port]>[peer_tag_param]
      Call-ID: [call_id]
      CSeq: 1 ACK
      [routes]
      Contact: <sip:sipp@[local_ip]:[local_port]>
      Max-Forwards: 70
      Content-Length: 0
]]></send>${dtmf}
  <pause milliseconds="${tailMs}"/>
  <send retrans="500"><![CDATA[${head('BYE', cseq, '\n      Content-Length: 0')}
]]></send>
  <recv response="200" crlf="true"/>
</scenario>
`;
}
