package mindmodel.engine.model;

import java.io.File;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import spoon.reflect.code.CtInvocation;
import spoon.reflect.cu.CompilationUnit;
import spoon.reflect.cu.SourcePosition;
import spoon.reflect.declaration.CtElement;
import spoon.support.reflect.cu.position.SourcePositionImpl;

/**
 * Source positions: project-relative files, and the element's own first token. One instance per dump run, because it
 * owns the checkout's root and the cache of relative names.
 */
public final class Positions {

    /** A position as the dump writes it. */
    public record Pos(String file, int line, int col, int endLine, int endCol) {
    }

    private final Path root;
    /** Project-relative names by file: one dump reads a million-odd elements of the same few thousand files. */
    private final Map<File, String> relative = new HashMap<>();

    /** The checkout the positions are relative to; every path is measured against this canonical root. */
    public Positions(Path root) {
        this.root = root.toAbsolutePath().normalize();
    }

    public Path root() {
        return root;
    }

    /** The element's own first token as a project-relative position, or null when Spoon has none. */
    public Pos of(CtElement element) {
        SourcePosition p = element == null ? null : element.getPosition();
        if (p == null || !p.isValidPosition()) return null;
        return at(p);
    }

    /**
     * A call's position is its method name's token, not the first token of the call. Spoon starts an invocation at its
     * target, so `a.b().c()` would put both calls at `a`; the name is the identifier before the `(` that opens the
     * call's own argument list. When the text does not show that name, the call's own position is the answer.
     */
    public Pos ofCall(CtInvocation<?> call) {
        Pos whole = of(call);
        SourcePosition p = call.getPosition();
        if (whole == null || call.getTarget() == null || call.getExecutable() == null) return whole;
        CompilationUnit unit = p.getCompilationUnit();
        if (unit == null || unit.getOriginalSourceCode() == null) return whole;
        int[] name = nameSpan(unit.getOriginalSourceCode(), p.getSourceStart(), p.getSourceEnd(),
                call.getExecutable().getSimpleName());
        if (name == null) return whole;
        // Spoon's own line and column for the name's offsets: the same rules as the call's position, tabs included.
        SourcePosition at = new SourcePositionImpl(unit, name[0], name[1], unit.getLineSeparatorPositions());
        return at(at);
    }

    /** A Spoon position as a project-relative one. */
    private Pos at(SourcePosition p) {
        File file = p.getFile();
        String rel = file == null ? "" : relative.computeIfAbsent(file,
                f -> root.relativize(f.toPath().toAbsolutePath().normalize()).toString().replace('\\', '/'));
        return new Pos(rel, p.getLine(), p.getColumn(), p.getEndLine(), p.getEndColumn());
    }

    /**
     * The offsets of a call's method name in its source, or null. The call's own argument list is the last `(` at the
     * top level of the span (the span ends with that list's `)`): the name is the identifier right before it. Strings,
     * characters, comments and nested brackets are skipped, so a `(` in a literal or a receiver's argument is never it.
     */
    static int[] nameSpan(String src, int start, int end, String name) {
        int open = -1;
        int depth = 0;
        int i = start;
        int last = Math.min(end, src.length() - 1);
        while (i <= last) {
            int skip = literalOrCommentLength(src, i);
            if (skip > 0) {
                i += skip;
                continue;
            }
            char c = src.charAt(i);
            if (c == '(' && depth == 0) open = i;
            if (c == '(' || c == '[' || c == '{') depth++;
            if (c == ')' || c == ']' || c == '}') depth--;
            i++;
        }
        if (open < 0) return null;
        int stop = open;
        while (stop > start && Character.isWhitespace(src.charAt(stop - 1))) stop--;
        int from = stop;
        while (from > start && Character.isJavaIdentifierPart(src.charAt(from - 1))) from--;
        if (from == stop || !src.substring(from, stop).equals(name)) return null;
        return new int[] {from, stop - 1};
    }

    /**
     * The length of the string, character or comment literal starting at {@code i}, or 0 when none starts there. A text
     * block runs to its closing triple quote.
     */
    private static int literalOrCommentLength(String src, int i) {
        if (src.startsWith("//", i)) return untilEol(src, i) - i;
        if (src.startsWith("/*", i)) {
            int close = src.indexOf("*/", i + 2);
            return close < 0 ? src.length() - i : close + 2 - i;
        }
        if (src.startsWith("\"\"\"", i)) {
            int close = src.indexOf("\"\"\"", i + 3);
            return close < 0 ? src.length() - i : close + 3 - i;
        }
        char quote = src.charAt(i);
        if (quote != '"' && quote != '\'') return 0;
        int j = i + 1;
        while (j < src.length() && src.charAt(j) != quote && src.charAt(j) != '\n') j += src.charAt(j) == '\\' ? 2 : 1;
        return Math.min(j + 1, src.length()) - i;
    }

    private static int untilEol(String src, int i) {
        int eol = src.indexOf('\n', i);
        return eol < 0 ? src.length() : eol;
    }

    /** The line an element is written on, or null when Spoon has no position for it. */
    public static Integer lineOf(CtElement element) {
        SourcePosition p = element == null ? null : element.getPosition();
        return p == null || !p.isValidPosition() ? null : p.getLine();
    }
}
