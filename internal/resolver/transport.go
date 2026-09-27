package resolver

import "strings"

// transportPhrases are how a lost connection reads in yt-dlp's output and in
// wrapped errors that no longer carry their Go type.
var transportPhrases = []string{
	"unable to download api page",
	"unable to download webpage",
	"connection aborted",
	"remotedisconnected",
	"getaddrinfo failed",
	"failed to resolve",
	"name resolution",
	"no such host",
	"connection refused",
	"network is unreachable",
	"no route to host",
	"timed out",
	"proxyconnect",
	"unable to connect to proxy",
	"connection reset",
	"actively refused",
	"forcibly closed",
}

// IsTransportError reports whether err reads as a failure to reach upstream at
// all, rather than an answer from it.
func IsTransportError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, p := range transportPhrases {
		if strings.Contains(msg, p) {
			return true
		}
	}
	return false
}
