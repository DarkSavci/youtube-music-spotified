package api

// BoundedRangeForTest exposes the range capping to the external test package.
//
// The capping is the whole reason playback works — upstream refuses an
// unbounded request — so it is worth testing directly rather than only through
// a relayed response.
func BoundedRangeForTest(clientRange string, size int64) string {
	return boundedRange(clientRange, size)
}
