// Convert existing internal candidate fixtures explicitly at the provider boundary.
// Production accepts only the typed wire representation, never this adapter.
function wireCandidate(candidate) {
  const {evidence, ...wire} = candidate;
  for (const key of Object.keys(wire)) {
    if (key === 'confidence' || key === 'review') continue;
    wire[key] = candidate[key] === '' ? null : {
      value: candidate[key], quote: evidence?.[key]?.quote ?? '', image: evidence?.[key]?.image ?? null
    };
  }
  return wire;
}
module.exports = {wireCandidate};
