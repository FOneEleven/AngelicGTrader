import React, { useId } from 'react';

export default function SeasonToken({ pieceType = 'Quarterback', baseColor = '#c49b4b', size = 112 }) {
  const uid = useId().replace(/:/g, '');
  const type = String(pieceType).toLowerCase();
  const basketball = /dunk|posterizer|dribbler|3pt/.test(type);
  const football = /quarterback|running back|receiver|lineman/.test(type);
  const baseball = /baseball|slugger|heater|catcher|runner/.test(type);
  const baseballRole = type.includes('slugger') ? 'slugger' : type.includes('heater') ? 'heater' : type.includes('catcher') ? 'catcher' : 'runner';
  const armPoses = {
    quarterback: 'M48 50 L34 54 L29 45 M72 50 L87 58 L94 54',
    'running back': 'M48 50 L42 63 L54 72 M72 50 L82 62 L78 77',
    receiver: 'M48 50 L38 38 L33 24 M72 50 L82 38 L89 23',
    lineman: 'M48 50 L30 58 L22 70 M72 50 L90 58 L98 70',
    'slam dunk': 'M48 50 L34 60 L28 77 M72 50 L84 35 L91 18',
    posterizer: 'M48 50 L40 36 L43 19 M72 50 L80 36 L77 19',
    dribbler: 'M48 50 L34 64 L30 84 M72 50 L85 66 L91 88',
    '3pt shooter': 'M48 50 L42 35 L49 22 M72 50 L78 35 L71 22',
  };
  const baseballPoses = {
    slugger: 'M48 50 L35 42 L31 28 M72 50 L84 40 L91 25',
    heater: 'M48 50 L35 39 L31 22 M72 50 L82 57 L91 70',
    catcher: 'M48 50 L35 63 L31 79 M72 50 L85 63 L89 79',
    runner: 'M48 50 L34 39 L25 48 M72 50 L86 38 L95 49',
  };
  const armPath = baseball ? baseballPoses[baseballRole] : (armPoses[type] || armPoses.quarterback);
  const ballTransform = type === 'quarterback' ? 'translate(29 45) rotate(-25)' :
    type === 'running back' ? 'translate(54 73) rotate(-25)' :
    type === 'receiver' ? 'translate(90 23) rotate(-25)' :
    type === 'lineman' ? 'translate(96 71) rotate(-25)' :
    type === 'slam dunk' ? 'translate(91 17)' :
    type === 'posterizer' ? 'translate(60 15)' :
    type === 'dribbler' ? 'translate(91 90)' : 'translate(60 18)';
  const baseballBallTransform = baseballRole === 'slugger' ? 'translate(95 23)' : baseballRole === 'heater' ? 'translate(92 71)' : baseballRole === 'catcher' ? 'translate(60 83)' : 'translate(25 49)';
  return <div className="season-token-art" style={{ width: size, height: size + 12 }}>
    <svg viewBox="0 0 120 138" width={size} height={size + 12} role="img" aria-label={pieceType + ' statue token'}>
      <defs>
        <linearGradient id={'statue-metal-' + uid} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff1c4"/><stop offset=".38" stopColor="#c7a35b"/><stop offset="1" stopColor="#6d4c20"/></linearGradient>
        <linearGradient id={'token-base-' + uid} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={baseColor}/><stop offset="1" stopColor="#171923"/></linearGradient>
      </defs>
      <ellipse cx="60" cy="126" rx="39" ry="7" fill="#000" opacity=".38"/>
      <path d="M25 103 Q60 94 95 103 L89 119 Q60 128 31 119Z" fill={'url(#token-base-' + uid + ')'} stroke={baseColor} strokeWidth="2"/>
      <ellipse cx="60" cy="103" rx="35" ry="8" fill={baseColor} stroke="#f2d99c" strokeWidth="1.5"/>
      <path d="M44 96 L47 83 L43 68 Q39 61 43 54 L51 47 L69 47 L78 55 Q82 62 77 69 L73 84 L77 96Z" fill={'url(#statue-metal-' + uid + ')'} stroke="#6f5127" strokeWidth="1.4"/>
      <circle cx="60" cy="34" r="11" fill={'url(#statue-metal-' + uid + ')'} stroke="#6f5127" strokeWidth="1.4"/>
      <path d={armPath} fill="none" stroke={'url(#statue-metal-' + uid + ')'} strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M51 83 L45 101 M69 83 L76 101" fill="none" stroke={'url(#statue-metal-' + uid + ')'} strokeWidth="9" strokeLinecap="round"/>
      {football && <g transform={ballTransform}><ellipse cx="0" cy="0" rx="8" ry="5" fill="#6d3e1e" stroke="#d6b27a" strokeWidth="1.2"/><path d="M-4 0H4 M0 -3V3" stroke="#f3e2bd" strokeWidth="1"/></g>}
      {baseball && <g transform={baseballBallTransform}><circle cx="0" cy="0" r="7" fill="#f5f1e8" stroke="#b7a58c" strokeWidth="1"/><path d="M-3 -5 Q1 -1 -3 5 M3 -5 Q-1 -1 3 5" fill="none" stroke="#bd4b4b" strokeWidth="1.1"/></g>}
      {baseball && baseballRole === 'slugger' && <g transform="translate(92 25) rotate(35)"><rect x="-2" y="-24" width="4" height="25" rx="2" fill="#9b6a35" stroke="#f0d19a" strokeWidth=".8"/><rect x="-2.5" y="-25" width="5" height="5" rx="2" fill="#d8b47b"/></g>}
      {basketball && <g transform={ballTransform}><circle cx="0" cy="0" r="8" fill="#b96f2e" stroke="#f2c17a" strokeWidth="1.2"/><path d="M-8 0H8 M0 -8V8 M-6 -6Q6 6 6 -6 M-6 6Q6 -6 6 6" fill="none" stroke="#5d351d" strokeWidth="1"/></g>}
      <path d="M51 31 Q60 18 69 31" fill="none" stroke="#f4dfaa" strokeWidth="2" opacity=".7"/>
    </svg>
  </div>;
}
