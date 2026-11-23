package mindmodel.engine;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import spoon.Launcher;
import spoon.compiler.Environment;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.declaration.CtType;

/**
 * A Spoon model over an explicit file list: no classpath, no comments, no compilation. Files are resolved through
 * real paths so that the paths Spoon reports match the project-relative paths the Node side uses (macOS /tmp is a
 * symlink).
 */
public final class SourceModel {

    private final Path root;
    private final List<String> files;
    private final Launcher launcher;

    private SourceModel(Path root, List<String> files, Launcher launcher) {
        this.root = root;
        this.files = files;
        this.launcher = launcher;
    }

    /** Normalises the file list to project-relative POSIX paths and drops anything outside the root. */
    public static List<String> relativeFiles(Path root, List<String> listed) {
        Set<String> out = new LinkedHashSet<>();
        Path realRoot = realPath(root);
        for (String raw : listed) {
            if (raw == null) continue;
            String text = raw.trim();
            if (text.isEmpty() || !text.endsWith(".java")) continue;
            Path p = realPath(realRoot.resolve(text));
            if (!p.startsWith(realRoot) || !Files.isRegularFile(p)) continue;
            out.add(realRoot.relativize(p).toString().replace('\\', '/'));
        }
        return new ArrayList<>(out);
    }

    public static SourceModel build(Path root, List<String> relFiles) {
        return build(root, relFiles, compliance());
    }

    /** The project's Java level: an explicit MINDMODEL_COMPLIANCE, else 17. Hertzbeat needs 21 for switch patterns. */
    public static int compliance() {
        String env = System.getenv("MINDMODEL_COMPLIANCE");
        if (env != null && env.matches("\\d{2}")) return Integer.parseInt(env);
        return 17;
    }

    public static SourceModel build(Path root, List<String> relFiles, int compliance) {
        Path realRoot = realPath(root);
        Launcher launcher = new Launcher();
        Environment env = launcher.getEnvironment();
        env.setNoClasspath(true);
        env.setCommentEnabled(false);
        env.setShouldCompile(false);
        env.setIgnoreDuplicateDeclarations(true);
        env.setComplianceLevel(compliance);
        env.setAutoImports(false);
        env.setCopyResources(false);
        env.setLevel("OFF");
        for (String rel : relFiles) launcher.addInputResource(realRoot.resolve(rel).toString());
        launcher.buildModel();
        return new SourceModel(realRoot, List.copyOf(relFiles), launcher);
    }

    public Path root() {
        return root;
    }

    public List<String> files() {
        return files;
    }

    public List<CtType<?>> allTypes() {
        return new ArrayList<>(launcher.getModel().getAllTypes());
    }

    /** Every invocation anywhere in the model, anonymous and local class bodies included. */
    public List<CtInvocation<?>> allInvocations() {
        return new ArrayList<>(launcher.getModel().getElements(new spoon.reflect.visitor.filter.TypeFilter<>(
                CtInvocation.class)));
    }

    /** Every type declared in one of the listed files, anonymous and local types included. */
    public List<CtType<?>> typesInProject() {
        List<CtType<?>> out = new ArrayList<>();
        for (CtType<?> t : allTypes()) if (fileOf(t) != null) out.add(t);
        return out;
    }

    /** Project-relative path of the file a type is declared in, or null when Spoon has no usable position. */
    public String fileOf(CtType<?> t) {
        if (t == null || t.getPosition() == null || !t.getPosition().isValidPosition()) return null;
        java.io.File f = t.getPosition().getFile();
        if (f == null) return null;
        Path p = realPath(f.toPath());
        if (!p.startsWith(root)) return null;
        String rel = root.relativize(p).toString().replace('\\', '/');
        return files.contains(rel) ? rel : null;
    }

    /** Project-relative path of the file an element is declared in; null for library and shadow elements. */
    public String fileOf(spoon.reflect.declaration.CtElement e) {
        if (e == null || e.getPosition() == null || !e.getPosition().isValidPosition()) return null;
        java.io.File f = e.getPosition().getFile();
        if (f == null) return null;
        Path p = realPath(f.toPath());
        if (!p.startsWith(root)) return null;
        String rel = root.relativize(p).toString().replace('\\', '/');
        return files.contains(rel) ? rel : null;
    }

    /** Parse problems JDT reported, so the dump can name a file it could not read instead of dropping it silently. */
    public List<org.eclipse.jdt.core.compiler.CategorizedProblem> problems() {
        List<org.eclipse.jdt.core.compiler.CategorizedProblem> out = new ArrayList<>();
        if (!(launcher.getModelBuilder()
                instanceof spoon.support.compiler.jdt.JDTBasedSpoonCompiler compiler)) return out;
        for (org.eclipse.jdt.core.compiler.CategorizedProblem p : compiler.getProblems())
            if (p.isError()) out.add(p);
        return out;
    }

    public static Path realPath(Path p) {
        try {
            return p.toRealPath();
        } catch (IOException e) {
            return p.toAbsolutePath().normalize();
        }
    }
}
