package mindmodel.engine.model;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import spoon.reflect.cu.CompilationUnit;

/**
 * The text of a source file, decoded the way Spoon parses it: UTF-8 when the bytes are valid UTF-8, else ISO-8859-1.
 * ISO-8859-1 maps every byte, so no file is unreadable, and a file that needed it is counted as `files.notUtf8`.
 * Spoon's own {@code getOriginalSourceCode()} decodes strictly with one encoding for the whole run and throws on such
 * a file, so every reader of a unit's text goes through here.
 */
public final class SourceText {

    /**
     * The text of each file, read once per run, keyed by its path. Not keyed by the unit: a Spoon element's equals and
     * hashCode are structural, so two units of the same shape would share one entry.
     */
    private static final Map<String, String> FILES = new HashMap<>();

    private SourceText() {
    }

    /** The charset a file's bytes are read with: UTF-8 when they are valid UTF-8, else ISO-8859-1. */
    public static Charset charsetOf(byte[] bytes) {
        try {
            StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes));
            return StandardCharsets.UTF_8;
        } catch (CharacterCodingException e) {
            return StandardCharsets.ISO_8859_1;
        }
    }

    /** The text of the bytes, decoded with {@link #charsetOf}. */
    public static String decode(byte[] bytes) {
        return new String(bytes, charsetOf(bytes));
    }

    /** The text of a file, or null when it cannot be read. */
    public static String read(Path file) {
        try {
            return decode(Files.readAllBytes(file));
        } catch (IOException e) {
            return null;
        }
    }

    /** True when a file's bytes are not valid UTF-8 (so {@link #decode} reads them as ISO-8859-1); false if unread. */
    public static boolean notUtf8(Path file) {
        try {
            return charsetOf(Files.readAllBytes(file)) != StandardCharsets.UTF_8;
        } catch (IOException e) {
            return false;
        }
    }

    /** The unit's text as Spoon parsed it, or null when its file is not there (a unit Spoon built from nothing). */
    public static String of(CompilationUnit unit) {
        if (unit == null || unit.getFile() == null || !unit.getFile().exists()) return null;
        return FILES.computeIfAbsent(unit.getFile().getAbsolutePath(), p -> read(Path.of(p)));
    }

    /** Forgets the texts read so far: a run starts with none, so a checkout read again is read again. */
    public static void clear() {
        FILES.clear();
    }

    /** Self-checks: run on import, as the other engine modules do. */
    static {
        byte[] latin1 = {'c', 'a', 'f', (byte) 0xE9};
        byte[] utf8 = {'c', 'a', 'f', (byte) 0xC3, (byte) 0xA9};
        assert charsetOf(latin1) == StandardCharsets.ISO_8859_1;
        assert charsetOf(utf8) == StandardCharsets.UTF_8;
        assert decode(latin1).equals("café") && decode(utf8).equals("café");
        assert decode(new byte[0]).isEmpty();
    }
}
