package mindmodel.engine.resolve;

import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.Map;

import spoon.reflect.declaration.CtElement;

import mindmodel.engine.model.Positions;

/**
 * The stable id of every call site and method reference: {@code <owning method>@<line>:<col>}, with {@code ~2}, {@code
 * ~3} on the second and later sites that start on the same token. An argument that is a call names its row by this id.
 *
 * <p>Ids are assigned per body, in source order, before any of its rows is written: a row's argument may name a call
 * that comes after it.
 */
public final class CallIds {

    private final Map<CtElement, String> ids = new IdentityHashMap<>();
    private final Map<String, Integer> used = new HashMap<>();

    /** The id of a site already assigned, or null when it has no row (a field initialiser is nobody's call). */
    public String id(CtElement site) {
        return site == null ? null : ids.get(site);
    }

    /** Gives one site its id. Called in source order, once per body, before the body's rows are written. */
    public void assign(CtElement site, String methodId, Positions.Pos pos) {
        String base = methodId + "@" + pos.line() + ":" + pos.col();
        int n = used.merge(base, 1, Integer::sum);
        ids.put(site, n == 1 ? base : base + "~" + n);
    }
}
