package resolver

import "testing"

func TestVideoFormatsDoNotReplaceAudioOrChooseManifests(t *testing.T) {
	formats := []ytdlpFormat{
		{URL: "audio", Ext: "webm", ACodec: "opus", VCodec: "none", ABR: 160, Protocol: "https"},
		{URL: "4k", Ext: "mp4", VCodec: "avc1", Height: 2160, Protocol: "https"},
		{URL: "hls", Ext: "mp4", VCodec: "avc1", Height: 1080, Protocol: "m3u8_native"},
		{URL: "picture", Ext: "mp4", VCodec: "avc1", Height: 1080, Protocol: "https"},
		{URL: "lower", Ext: "mp4", VCodec: "avc1", Height: 720, Protocol: "https"},
	}
	if bestYtdlpVideo(formats).URL != "picture" {
		t.Fatal("wrong video format")
	}
	if bestYtdlpAudio(formats).URL != "audio" {
		t.Fatal("audio format selection changed")
	}
	if bestYtdlpVideo(formats[:1]) != nil {
		t.Fatal("audio-only format became a video")
	}
}
