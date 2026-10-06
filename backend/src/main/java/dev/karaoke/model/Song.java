package dev.karaoke.model;

import java.time.Instant;
import java.util.Map;

/**
 * Metadados de uma música. Imutável: cada mudança gera uma nova instância,
 * que o SongService persiste em meta.json dentro da pasta da música.
 *
 * @param files nome lógico -> nome do arquivo (ex.: "lead" -> "lead.flac"); só preenchido quando READY
 */
public record Song(
        String id,
        String title,
        String artist,
        SongStatus status,
        String error,
        Instant createdAt,
        Map<String, String> files) {

    public Song withStatus(SongStatus newStatus) {
        return new Song(id, title, artist, newStatus, null, createdAt, files);
    }

    public Song withReady(Map<String, String> newFiles) {
        return new Song(id, title, artist, SongStatus.READY, null, createdAt, newFiles);
    }

    public Song withError(String message) {
        return new Song(id, title, artist, SongStatus.FAILED, message, createdAt, files);
    }
}
