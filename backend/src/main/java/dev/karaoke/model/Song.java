package dev.karaoke.model;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Metadados de uma música. Imutável: cada mudança gera uma nova instância,
 * que o SongService persiste em meta.json dentro da pasta da música.
 *
 * @param files          nome lógico -> arquivo ("instrumental", "lead", "backing", "lyrics", "cover", "words")
 * @param lyricsOffsetMs atraso da letra em ms (positivo = letra aparece mais tarde)
 * @param rev            sobe a cada troca de letra/capa/palavras; vai na URL como ?v= para furar o cache do navegador
 * @param wordsState     null (nada em andamento), "RUNNING" ou "FAILED" — alinhamento palavra a palavra
 * @param wordsError     motivo da falha do alinhamento
 */
public record Song(
        String id,
        String title,
        String artist,
        SongStatus status,
        String error,
        Instant createdAt,
        Map<String, String> files,
        int lyricsOffsetMs,
        int rev,
        String wordsState,
        String wordsError) {

    public static final String WORDS_RUNNING = "RUNNING";
    public static final String WORDS_FAILED = "FAILED";

    public Song {
        files = files == null ? Map.of() : Map.copyOf(files);
    }

    public static Song queued(String id, String title, String artist) {
        return new Song(id, title, artist, SongStatus.QUEUED, null, Instant.now(), Map.of(), 0, 0, null, null);
    }

    public Song withStatus(SongStatus newStatus) {
        return new Song(id, title, artist, newStatus, null, createdAt, files, lyricsOffsetMs, rev,
                wordsState, wordsError);
    }

    /** Junta os arquivos gerados pela separação aos que já existem (letra/capa). */
    public Song withReady(Map<String, String> generated) {
        return new Song(id, title, artist, SongStatus.READY, null, createdAt,
                merge(files, generated), lyricsOffsetMs, rev, wordsState, wordsError);
    }

    public Song withError(String message) {
        return new Song(id, title, artist, SongStatus.FAILED, message, createdAt, files, lyricsOffsetMs, rev,
                wordsState, wordsError);
    }

    /**
     * Troca letra ou capa. Uma letra nova zera o ajuste de sincronia e descarta as palavras
     * alinhadas (os dois foram feitos para a letra anterior).
     */
    public Song withFile(String key, String filename) {
        if ("lyrics".equals(key)) {
            Map<String, String> merged = merge(files, Map.of(key, filename));
            merged.remove("words");
            return new Song(id, title, artist, status, error, createdAt, merged, 0, rev + 1, null, null);
        }
        return new Song(id, title, artist, status, error, createdAt,
                merge(files, Map.of(key, filename)), lyricsOffsetMs, rev + 1, wordsState, wordsError);
    }

    public Song withLyricsOffset(int ms) {
        return new Song(id, title, artist, status, error, createdAt, files, ms, rev, wordsState, wordsError);
    }

    public Song withWordsState(String state, String errorMessage) {
        return new Song(id, title, artist, status, error, createdAt, files, lyricsOffsetMs, rev, state, errorMessage);
    }

    public Song withWordsReady(String filename) {
        return new Song(id, title, artist, status, error, createdAt,
                merge(files, Map.of("words", filename)), lyricsOffsetMs, rev + 1, null, null);
    }

    private static Map<String, String> merge(Map<String, String> a, Map<String, String> b) {
        Map<String, String> merged = new LinkedHashMap<>(a);
        merged.putAll(b);
        return merged;
    }
}
