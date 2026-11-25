namespace School.Application.Classes;

public interface IClassService
{
    Task<PagedResult<ClassDto>> ListAsync(IReadOnlyCollection<int> schoolIds, int page, CancellationToken ct);
    Task<ClassDto> CreateAsync(CreateClassDto dto, IReadOnlyCollection<int> schoolIds, CancellationToken ct);
    Task UpdateAsync(int id, UpdateClassDto dto, IReadOnlyCollection<int> schoolIds, CancellationToken ct);
}
