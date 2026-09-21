// Command rangeprobe finds how upstream wants large reads asked for.
package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"spotifier/internal/resolver"
)

const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

func try(client *http.Client, url, rangeHeader, label string) {
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Origin", "https://music.youtube.com")
	req.Header.Set("Referer", "https://music.youtube.com/")
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("%-40s ERROR %v\n", label, err)
		return
	}
	defer resp.Body.Close()
	n, _ := io.Copy(io.Discard, resp.Body)
	fmt.Printf("%-40s %d  %d bytes\n", label, resp.StatusCode, n)
}

func main() {
	vid := os.Args[1]
	r := resolver.NewLibrary()
	s, _, err := r.Resolve(context.Background(), vid)
	if err != nil {
		fmt.Println("resolve:", err)
		os.Exit(1)
	}
	fmt.Println("size:", s.SizeBytes)
	client := &http.Client{Timeout: 90 * time.Second}

	const win = 1 << 20
	try(client, s.URL, fmt.Sprintf("bytes=0-%d", win-1), "url#1  0 .. 1M")
	try(client, s.URL, fmt.Sprintf("bytes=0-%d", win-1), "url#1  0 .. 1M  (again)")
	try(client, s.URL, fmt.Sprintf("bytes=%d-%d", win, 2*win-1), "url#1  1M .. 2M")

	s2, _, err := r.Resolve(context.Background(), vid)
	if err != nil {
		fmt.Println("re-resolve:", err)
		return
	}
	try(client, s2.URL, fmt.Sprintf("bytes=0-%d", win-1), "url#2  0 .. 1M")
	try(client, s2.URL, fmt.Sprintf("bytes=%d-%d", win, 2*win-1), "url#2  1M .. 2M")
	try(client, s2.URL, "bytes=0-2047", "url#2  small tail probe")

	// Whole file in one go, which is what a download would do.
	s3, _, err := r.Resolve(context.Background(), vid)
	if err == nil {
		try(client, s3.URL, fmt.Sprintf("bytes=0-%d", s3.SizeBytes-1), "url#3  whole file bounded")
	}
}
