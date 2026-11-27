import React from 'react';

export default function SeasonToken({ pieceType = 'Quarterback', baseColor = '#c49b4b', size = 112 }) {
  const basketball = /Dunk|Posterizer|Dribbler|3Pt/i.test(pieceType);
  const football = /Quarterback|Running Back|Receiver|Lineman/i.test(pieceType);
  return <div className="season-token-art" style={{ width: size, height: size + 12 }}>
    <svg viewBox="0 0 120 138" width={size} height={size + 12} role="img" aria-label={pieceType + ' statue token'}>
      <defs>
        <linearGradient id="statue-metal" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff1c4"/><stop offset=".38" stopColor="#c7a35b"/><stop offset="1" stopColor="#6d4c20"/></linearGradient>
        <linearGradient id="token-base" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={baseColor}/><stop offset="1" stopColor="#171923"/></linearGradient>
      </defs>
      <ellipse cx="60" cy="126" rx="39" ry="7" fill="#000" opacity=".38"/>
      <path d="M25 103 Q60 94 95 103 L89 119 Q60 128 31 119Z" fill="url(#token-base)" stroke={baseColor} strokeWidth="2"/>
      <ellipse cx="60" cy="103" rx="35" ry="8" fill={baseColor} stroke="#f2d99c" strokeWidth="1.5"/>
      <path d="M44 96 L47 83 L43 68 Q39 61 43 54 L51 47 L69 47 L78 55 Q82 62 77 69 L73 84 L77 96Z" fill="url(#statue-metal)" stroke="#6f5127" strokeWidth="1.4"/>
      <circle cx="60" cy="34" r="11" fill="url(#statue-metal)" stroke="#6f5127" strokeWidth="1.4"/>
      <path d="M48 50 L34 62 L25 79 Q23 84 28 86 Q32 87 35 82 L49 68 M72 50 L85 61 L94 76 Q97 82 92 85 Q87 87 84 81 L70 68" fill="none" stroke="url(#statue-metal)" strokeWidth="8" strokeLinecap="round"/>
      <path d="M51 83 L45 101 M69 83 L76 101" fill="none" stroke="url(#statue-metal)" strokeWidth="9" strokeLinecap="round"/>
      {football && <g transform="translate(83 69) rotate(-28)"><ellipse cx="0" cy="0" rx="8" ry="5" fill="#6d3e1e" stroke="#d6b27a" strokeWidth="1.2"/><path d="M-4 0H4 M0 -3V3" stroke="#f3e2bd" strokeWidth="1"/></g>}
      {basketball && <g><circle cx="88" cy="70" r="8" fill="#b96f2e" stroke="#f2c17a" strokeWidth="1.2"/><path d="M80 70H96 M88 62V78 M82 64Q94 76 94 64 M82 76Q94 64 94 76" fill="none" stroke="#5d351d" strokeWidth="1"/></g>}
      <path d="M51 31 Q60 18 69 31" fill="none" stroke="#f4dfaa" strokeWidth="2" opacity=".7"/>
    </svg>
  </div>;
}
