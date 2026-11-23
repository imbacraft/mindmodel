package orders;

import java.util.List;

public class PortImpl implements Port<Order> {
    @Override
    public List<Order> findAll() { return List.of(); }

    @Override
    public <R> R map(Order value, java.util.function.Function<Order, R> fn) { return fn.apply(value); }
}
