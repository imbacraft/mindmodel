package app;

import gen.mapper.OrderMapperImpl;

/** The map writes nothing about gen.mapper, but a project call into a generated mapper still resolves. */
public class GeneratedUse {

    private final OrderMapperImpl mapper = OrderMapperImpl.instance();

    public String label(Order order) {
        OrderDto dto = mapper.toDto(order);
        return nameOf(dto);
    }

    private String nameOf(OrderDto dto) {
        return dto.getName();
    }
}
