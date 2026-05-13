// A single label / value row inside a recipe's expanded detail panel.
// Total rows get a top border; "big" rows enlarge for emphasis.
export default function DetailLine({ name, num, color, total, big }) {
  return (
    <div
      className={`detail-line ${total ? 'total' : ''}`}
      style={big ? { fontSize: '1.05em' } : undefined}
    >
      <span className="name">{name}</span>
      <span className="num" style={{ color, fontWeight: total ? 500 : undefined }}>
        {num}
      </span>
    </div>
  );
}
