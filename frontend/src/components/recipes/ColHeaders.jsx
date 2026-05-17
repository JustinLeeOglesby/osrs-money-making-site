// Static column-header row sitting above each subcategory's recipe list.
export default function ColHeaders() {
  return (
    <div className="recipe col-headers">
      <div className="recipe-summary">
        <div className="recipe-name">Recipe</div>
        <div>Profit</div>
        <div>GP / hr</div>
        <div>XP</div>
        <div>GP / XP</div>
        <div>4hr limit</div>
        <div>Hourly vol</div>
      </div>
    </div>
  );
}
