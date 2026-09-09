function digest_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (v) { return ('0' + ((v + 256) % 256).toString(16)).slice(-2); }).join('');
}
