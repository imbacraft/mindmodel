package shop;

public class BookingService {
    public Booking book() {
        return Booking.builder().status(OrderStatus.PAID).build();
    }
}
