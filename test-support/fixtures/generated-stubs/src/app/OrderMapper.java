package app;

import java.util.List;

/** What a person writes; the annotation processor writes the class that does it (gen.mapper.OrderMapperImpl). */
public interface OrderMapper {

    OrderDto toDto(Order order);

    List<OrderDto> all(List<Order> orders);
}
